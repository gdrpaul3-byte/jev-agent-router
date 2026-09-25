import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlaywrightGoal, parseArguments, main, PLAYWRIGHT_ARM } from './claude-playwright-goal.mjs';

const START = 'https://example.com/';
const plan = {
  goal: 'Click "Open" until the page shows "Guide ready".',
  allowedOrigins: ['https://example.com'],
  actions: [{ id: 'open', action: 'click', description: 'Open the guide', target: { roles: ['button'], nameEquals: 'Open' } }],
  completion: { textIncludes: 'Guide ready', urlIncludes: '/guide' },
  maxSteps: 3, maxDurationMs: 20000,
};

function fakeBrowser({ closeError, gotoError, loadError, lateRenderReads = 0 } = {}) {
  const events = []; let clicked = false, readsAfterClick = 0;
  const page = {
    setDefaultTimeout(value) { events.push(['timeout', value]); },
    async goto(url, options) { events.push(['goto', url, options.waitUntil]); if (gotoError) throw Object.assign(new Error('x'), { code: gotoError }); },
    async evaluate() {
      events.push(['observe']);
      // A same-document navigation: the URL changes first and the new list renders over the next reads.
      const rendering = clicked && readsAfterClick++ < lateRenderReads;
      const elements = !clicked ? [{ ref: 0, role: 'button', name: 'Open', editable: false, identity: 'open' }]
        : rendering ? [{ ref: 0, role: 'link', name: `Loading ${readsAfterClick}`, editable: false, identity: `spinner-${readsAfterClick}` }] : [];
      return JSON.stringify({ title: 'Fixture', url: clicked ? 'https://example.com/guide' : START, text: clicked && !rendering ? 'Guide ready' : 'Start',
        candidateCount: elements.length, elements });
    },
    locator() { return { nth(ref) { return { async click() { events.push(['click', ref]); clicked = true; } }; } }; },
    async waitForLoadState(state, options) { events.push(['load', state, options.timeout]); if (loadError) throw new Error('Timeout 30000ms exceeded'); },
  };
  const driver = { chromium: { async launch(options) {
    events.push(['launch', options]);
    return {
      async newContext(...args) { events.push(['context', args.length]); return { async newPage() { return page; } }; },
      async close() { events.push(['close']); if (closeError) throw new Error(closeError); },
    };
  } } };
  return { driver, events };
}
const decider = { async decide({ observation }) {
  return observation.text.includes('Guide ready') ? { status: 'done', confidence: 1, latencyMs: 0 }
    : { status: 'decided', actionId: 'open', ref: 0, confidence: 1, latencyMs: 0 };
} };

test('completes in an isolated headless context, records visits and returns the final text only on completion', async () => {
  const fake = fakeBrowser();
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.equal(result.status, 'completed');
  assert.equal(finalText, 'Guide ready');
  assert.deepEqual(result.visitedUrls, [START, 'https://example.com/guide']);
  assert.equal(result.finalUrl, 'https://example.com/guide');
  assert.deepEqual(fake.events[0], ['launch', { channel: 'chrome', headless: true, timeout: 30000 }]);
  assert.deepEqual(fake.events[1], ['context', 0], 'no storage state or profile is passed');
  assert.ok(fake.events.findIndex(e => e[0] === 'goto') < fake.events.findIndex(e => e[0] === 'observe'));
  assert.equal(fake.events.at(-1)[0], 'close');
  for (const key of ['setupMs', 'prepareMs', 'loopMs', 'finalReadMs', 'teardownMs', 'totalMs']) assert.ok(Number.isInteger(result.timing[key]), key);
  assert.equal(result.jev, null, 'an injected decider makes no metered requests');
  assert.equal(result.arm, 'opus+jev-playwright');
});

test('preparation runs after navigation and before the first observation, outside the loop timer', async () => {
  const fake = fakeBrowser(), order = [];
  const preparers = { none: null, slow: async () => { order.push(fake.events.length); await new Promise(r => setTimeout(r, 40)); return { closed: 1 }; } };
  const { result } = await runPlaywrightGoal({ plan, start: START, prepare: 'slow', decider, preparers, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.prepareEvidence, { closed: 1 });
  assert.ok(result.timing.prepareMs >= 30);
  assert.equal(fake.events.slice(0, order[0]).some(e => e[0] === 'observe'), false);
});

test('a failed preparation stops before any decision or click', async () => {
  const fake = fakeBrowser(); let decisions = 0;
  const preparers = { none: null, broken: async () => { throw Object.assign(new Error('x'), { code: 'VERIFICATION_FAILED' }); } };
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, prepare: 'broken', preparers, playwrightImpl: fake.driver, settleMs: 0,
    decider: { decide: async input => { decisions++; return decider.decide(input); } } });
  assert.deepEqual([result.status, result.reason, result.detail], ['needs_host', 'PREPARE_FAILED', 'VERIFICATION_FAILED']);
  assert.equal(finalText, null); assert.equal(decisions, 0);
  assert.equal(fake.events.some(e => e[0] === 'click'), false);
});

test('a stopped loop keeps its reason and final URL but never exposes page text', async () => {
  const fake = fakeBrowser();
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, playwrightImpl: fake.driver, settleMs: 0,
    decider: { decide: async () => ({ status: 'needs_host', reason: 'LOW_CONFIDENCE', latencyMs: 0 }) } });
  assert.deepEqual([result.status, result.reason], ['needs_host', 'LOW_CONFIDENCE']);
  assert.equal(finalText, null); assert.equal(result.finalUrl, START);
});

test('invalid plans, starts, preparations and a missing key stop before launching a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-goal-'));
  try {
    const emptyEnv = join(dir, 'empty.env'); await writeFile(emptyEnv, 'OTHER=1\n');
    const cases = [
      [{ plan: { ...plan, completion: {} }, start: START, decider }, 'INVALID_PLAN'],
      [{ plan: null, start: START, decider }, 'INVALID_PLAN'],
      [{ plan, start: 'https://other.example/', decider }, 'INVALID_START_URL'],
      [{ plan, start: 'file:///C:/private', decider }, 'INVALID_START_URL'],
      [{ plan, start: START, prepare: 'unknown', decider }, 'INVALID_PREPARE'],
      [{ plan, start: START, prepare: 'toString', decider }, 'INVALID_PREPARE'],
      [{ plan, start: START, envFile: emptyEnv }, 'MISSING_API_KEY'],
      [{ plan, start: START, decider: {} }, 'INVALID_PLAN'],
    ];
    for (const [options, reason] of cases) {
      const fake = fakeBrowser();
      const { result } = await runPlaywrightGoal({ ...options, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
      assert.equal(result.reason, reason, JSON.stringify(options.start) + reason);
      assert.equal(fake.events.length, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the plan cannot lower the pre-registered verification window, replans or confidence gates', async () => {
  assert.deepEqual(PLAYWRIGHT_ARM.api, { timeoutMs: 5000, maxInputBytes: 100000, minConfidence: 0.75, minMargin: 0.10 });
  assert.ok(Object.isFrozen(PLAYWRIGHT_ARM) && Object.isFrozen(PLAYWRIGHT_ARM.api));
  const fake = fakeBrowser();
  const { result } = await runPlaywrightGoal({ plan: { ...plan, verificationTimeoutMs: 1, maxStaleReplans: 0, api: { minConfidence: 0.5 } },
    start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.equal(result.status, 'completed');
  assert.equal(result.settings.verificationTimeoutMs, 30000);
  assert.deepEqual(result.effective, { maxSteps: 3, maxDurationMs: 20000, verificationTimeoutMs: 20000, maxStaleReplans: 2 });
});

test('live mode meters every JEV request and reports latency without leaking the key', async () => {
  const fake = fakeBrowser(); const secret = 'offline-secret-value';
  const answer = (criteria, choice) => ({ type: 'choice', choice, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])) });
  const fetchImpl = async (_url, request) => {
    assert.equal(request.headers.Authorization ?? request.headers.authorization, `Bearer ${secret}`);
    const body = JSON.parse(request.body);
    const done = body.state.observation.text.includes('Guide ready');
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) answers[name] = answer(question.criteria, name === 'operation' ? (done ? 'DONE' : 'open') : 'e_0');
    return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 7 }, answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { result } = await runPlaywrightGoal({ plan, start: START, apiKey: secret, fetchImpl, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.equal(result.status, 'completed');
  assert.equal(result.jev.requests, 2); assert.equal(result.jev.inputTokens, 14);
  assert.ok(result.jev.estimatedJevUsd > 0);
  assert.deepEqual(result.jev.perRequest.map(r => [r.model, r.httpStatus, r.inputTokens]), [['jev-1.13.0', 200, 7], ['jev-1.13.0', 200, 7]]);
  assert.ok(result.jev.perRequest.every(r => Number.isInteger(r.latencyMs)));
  assert.equal(result.jev.knownInputTokens, 14); assert.equal(result.jev.errors, 0); assert.equal(result.jev.pendingRequests, 0); assert.ok(result.jev.knownUsageUsd > 0);
  assert.equal(result.maxCalls, 6);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('close failure turns a completed run into a stop without final text', async () => {
  const fake = fakeBrowser({ closeError: 'boom' });
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.deepEqual([result.status, result.reason], ['needs_host', 'BROWSER_CLOSE_FAILED']);
  assert.equal(finalText, null);
});

test('arguments are strict and the CLI refuses an existing output directory', async () => {
  for (const argv of [[], ['--plan', 'p'], ['--plan', 'p', '--start', START], ['--plan', 'p', '--start', START, '--out', 'o', '--extra', 'x'],
    ['--plan', 'p', '--plan', 'q', '--start', START, '--out', 'o'], ['--plan', '--start', START, '--out', 'o']]) {
    assert.throws(() => parseArguments(argv), /INVALID_ARGUMENTS/, JSON.stringify(argv));
  }
  assert.deepEqual(parseArguments(['--plan', 'p', '--start', START, '--out', 'o', '--prepare', 'none', '--env-file', 'e']),
    { '--plan': 'p', '--start': START, '--out': 'o', '--prepare': 'none', '--env-file': 'e' });
  const dir = await mkdtemp(join(tmpdir(), 'pw-goal-cli-'));
  try {
    const planFile = join(dir, 'plan.json'); await writeFile(planFile, JSON.stringify({ plan }));
    const out = join(dir, 'out');
    const fake = fakeBrowser();
    const written = await main(['--plan', planFile, '--start', START, '--out', out], { decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
    assert.equal(written.status, 'completed');
    assert.equal(await readFile(join(out, 'final-text.txt'), 'utf8'), 'Guide ready');
    assert.equal(JSON.parse(await readFile(join(out, 'result.json'), 'utf8')).finalTextFile, join(out, 'final-text.txt'));
    await assert.rejects(main(['--plan', planFile, '--start', START, '--out', out], { decider, playwrightImpl: fakeBrowser().driver, settleMs: 0, postClickMs: 0 }), { code: 'EEXIST' });
    const existing = join(dir, 'existing'); await mkdir(existing);
    await assert.rejects(main(['--plan', planFile, '--start', START, '--out', existing], { decider, playwrightImpl: fakeBrowser().driver, settleMs: 0, postClickMs: 0 }), { code: 'EEXIST' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('each click waits for the new document and the post-click pause before the next observation', async () => {
  const fake = fakeBrowser();
  const started = performance.now();
  const { result } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 60 });
  assert.equal(result.status, 'completed');
  const click = fake.events.findIndex(e => e[0] === 'click');
  assert.deepEqual(fake.events[click + 1], ['load', 'domcontentloaded', 30000]);
  assert.equal(fake.events[click + 2][0], 'observe');
  assert.ok(performance.now() - started >= 55);
  assert.equal(fake.events.filter(e => e[0] === 'click').length, 1, 'the click is never replayed');
});

test('a late-rendering page is polled read-only until two captures agree before the loop observes it', async () => {
  const fake = fakeBrowser({ lateRenderReads: 3 });
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0, stablePollMs: 5 });
  assert.equal(result.status, 'completed'); assert.equal(finalText, 'Guide ready');
  assert.equal(result.settles.length, 1);
  assert.equal(result.settles[0].stable, true);
  assert.ok(result.settles[0].reads >= 5, JSON.stringify(result.settles[0]));
  assert.equal(fake.events.filter(e => e[0] === 'click').length, 1);
  assert.ok(result.observations.every(o => !('text' in o)) && result.observations.every(o => Number.isInteger(o.elements)));
});

test('a DOMContentLoaded timeout after a dispatched click stops as ACTION_FAILED/ACTION_TIMEOUT without a second click', async () => {
  const fake = fakeBrowser({ loadError: true });
  const { result, finalText } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0 });
  assert.deepEqual([result.status, result.reason, result.detail], ['needs_host', 'ACTION_FAILED', 'ACTION_TIMEOUT']);
  assert.equal(finalText, null);
  assert.equal(fake.events.filter(e => e[0] === 'click').length, 1);
});

test('a teardown failure keeps a stopped loop reason and is reported separately', async () => {
  const fake = fakeBrowser({ closeError: 'boom' });
  const { result } = await runPlaywrightGoal({ plan, start: START, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0,
    decider: { decide: async () => ({ status: 'needs_host', reason: 'LOW_CONFIDENCE', latencyMs: 0 }) } });
  assert.deepEqual([result.status, result.reason, result.teardownError], ['needs_host', 'LOW_CONFIDENCE', 'BROWSER_CLOSE_FAILED']);
});

test('no timer is left pending after a run, so the CLI process exits as soon as the result is written', async () => {
  const timers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
  const before = timers();
  const { result } = await runPlaywrightGoal({ plan, start: START, decider, playwrightImpl: fakeBrowser().driver, settleMs: 0, postClickMs: 0, stablePollMs: 1 });
  assert.equal(result.status, 'completed');
  assert.ok(timers() <= before, `${timers()} timers pending, ${before} before`);
});

test('a decider request timeout is labelled apart from the task deadline', async () => {
  const fake = fakeBrowser();
  const { result } = await runPlaywrightGoal({ plan, start: START, playwrightImpl: fake.driver, settleMs: 0, postClickMs: 0,
    decider: { decide: async () => ({ status: 'needs_host', reason: 'TIMEOUT', latencyMs: 5000 }) } });
  assert.deepEqual([result.reason, result.detail], ['TIMEOUT', 'JEV_REQUEST_TIMEOUT']);
});
