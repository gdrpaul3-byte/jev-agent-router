import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCuaSession, createDecider, runGoalWorkflow, prepareGoalPlan } from '../src/index.mjs';
import { runBrowserGoal } from '../src/browser-goal.mjs';

const plan = {
  url: 'https://example.com/', goal: 'Open the guide',
  actions: [{ id: 'open', action: 'click', description: 'Open the guide', target: { roles: ['button'], nameEquals: 'Open' } }],
  completion: { textIncludes: 'Guide ready', urlIncludes: '/guide' },
  maxSteps: 2, maxDurationMs: 1000, verificationTimeoutMs: 0,
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeBrowser({ launchDelay = 0, closeDelay = 0, launchError, closeError } = {}) {
  const events = []; let clicked = false;
  const page = {
    setDefaultTimeout(value) { events.push(['timeout', value]); },
    async goto(url, options) { events.push(['goto', url, options]); },
    async evaluate() { return {
      title: 'Guide fixture', url: clicked ? 'https://example.com/guide' : plan.url,
      text: clicked ? 'Guide ready' : 'Start', candidateCount: clicked ? 0 : 1,
      elements: clicked ? [] : [{ ref: 0, role: 'button', name: 'Open', editable: false, identity: 'open' }],
    }; },
    locator(selector) { events.push(['locator', selector]); return { nth(ref) { return { async click() { events.push(['click', ref]); clicked = true; } }; } }; },
  };
  const driver = { chromium: { async launch(options) {
    events.push(['launch', options]); await delay(launchDelay); if (launchError) throw new Error(launchError);
    return {
      async newContext(options) { events.push(['context', options]); return { async newPage() { return page; } }; },
      async close() { events.push(['close']); await delay(closeDelay); if (closeError) throw new Error(closeError); },
    };
  } } };
  const decider = { async decide({ observation }) { return observation.text.includes('Guide ready')
    ? { status: 'done', confidence: 1, latencyMs: 0 }
    : { status: 'decided', actionId: 'open', ref: 0, confidence: 1, latencyMs: 0 }; } };
  return { driver, decider, events };
}

function answer(criteria, choice) {
  return { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])) };
}

test('index exposes the goal API and a session aggregates real transport usage from both modes', async () => {
  assert.equal(typeof createDecider, 'function'); assert.equal(typeof runGoalWorkflow, 'function'); assert.equal(typeof prepareGoalPlan, 'function');
  let fetches = 0;
  const session = await createCuaSession({ apiKey: 'offline-secret', maxCalls: 3, fetchImpl: async (_url, request) => {
    fetches++;
    const body = JSON.parse(request.body);
    const answers = body.questions.operation ? { operation: answer(body.questions.operation.criteria, 'DONE') }
      : { target: answer(body.questions.target.criteria, 'e_0') };
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 10 }, answers }) };
  } });
  let clicked = false;
  const fixed = await session.workflow({ target: { getAXState: async () => `0 button Open\n${clicked ? 'Guide ready' : 'Start'}`, click: async () => { clicked = true; } },
    goal: plan.goal, steps: [{ instruction: 'Open', action: 'click', expect: { textIncludes: 'Guide ready' } }] });
  assert.equal(fixed.status, 'completed');
  const result = await session.goal({ ...plan, target: { getObservation: async () => ({ text: 'Guide ready', url: 'https://example.com/guide', elements: [] }), click: async () => {} } });
  assert.equal(result.status, 'completed'); assert.equal(fetches, 2);
  assert.equal(session.stats().calls, 2); assert.equal(session.stats().inputTokens, 20); assert.equal(session.stats().errors, 0);
  assert.equal(session.goalStats().calls, 1);
  assert.ok(Number.isFinite(session.stats().lastLatencyMs));
  assert.ok(!JSON.stringify(session.stats()).includes('offline-secret'));
});

test('session maxCalls is shared across fixed and goal workflows', async () => {
  let calls = 0;
  const session = await createCuaSession({ apiKey: 'offline', maxCalls: 1, fetchImpl: async (_url, request) => {
    calls++; const body = JSON.parse(request.body);
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 5 }, answers: { operation: answer(body.questions.operation.criteria, 'DONE') } }) };
  } });
  const target = { getObservation: async () => ({ text: 'Guide ready', url: 'https://example.com/guide', elements: [] }), click: async () => {} };
  assert.equal((await session.goal({ ...plan, target })).status, 'completed');
  const result = await session.workflow({ target: { getAXState: async () => '0 button Open', click: async () => {} }, goal: 'Open', steps: [{ instruction: 'Open', action: 'click', expect: { textIncludes: 'Missing' } }] });
  assert.equal(result.reason, 'CALL_BUDGET_EXHAUSTED'); assert.equal(calls, 1); assert.equal(session.stats().errors, 1);
});

test('goal browser validates full plans, API budgets, scope and options before configuration or launch', async () => {
  const invalid = [
    [{ ...plan, actions: [{ id: 'evil', action: 'evaluate', description: 'No' }] }, 'INVALID_PLAN'],
    [{ ...plan, completion: {} }, 'INVALID_PLAN'],
    [{ ...plan, url: 'file:///private' }, 'INVALID_START_URL'],
    [{ ...plan, url: 'https://user:secret@example.com' }, 'INVALID_START_URL'],
    [{ ...plan, allowedOrigins: ['https://other.example'] }, 'INVALID_START_URL'],
    ...[{ maxCalls: -1 }, { maxCalls: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { maxInputBytes: 0 },
      { minConfidence: 0.5 }, { minMargin: -1 }, { fetchImpl: 'unsafe' }].map(api => [{ ...plan, api }, 'INVALID_API_OPTIONS']),
  ];
  for (const [candidate, reason] of invalid) {
    const fake = fakeBrowser();
    const result = await runBrowserGoal({ plan: candidate, envFile: 'must-not-read.env', playwrightImpl: fake.driver });
    assert.equal(result.reason, reason); assert.equal(fake.events.length, 0);
  }
  const fake = fakeBrowser();
  assert.equal((await runBrowserGoal({ plan, decider: fake.decider, channel: 'private-profile', playwrightImpl: fake.driver })).reason, 'INVALID_BROWSER_OPTIONS');
  assert.equal((await runBrowserGoal({ plan, decider: {}, playwrightImpl: fake.driver })).reason, 'INVALID_PLAN');
  assert.equal(fake.events.length, 0);
});

test('missing key stops goal browser before launching', async () => {
  const fake = fakeBrowser();
  assert.equal((await runBrowserGoal({ plan, playwrightImpl: fake.driver })).reason, 'MISSING_API_KEY');
  assert.equal(fake.events.length, 0);
});

test('injected goal mode launches an isolated context and records inclusive setup, loop and teardown time', async () => {
  const fake = fakeBrowser({ launchDelay: 15, closeDelay: 15 });
  const result = await runBrowserGoal({ plan, decider: fake.decider, playwrightImpl: fake.driver, channel: 'chromium', headless: true });
  assert.equal(result.status, 'completed'); assert.equal(result.mode, 'injected-decider');
  assert.equal(fake.events.filter(([event]) => event === 'click').length, 1);
  assert.equal(fake.events.find(([event]) => event === 'context')[1], undefined);
  assert.equal(fake.events[0][1].headless, true); assert.equal(fake.events[0][1].channel, undefined);
  assert.equal(fake.events.at(-1)[0], 'close');
  assert.ok(result.timing.setupMs >= 10); assert.ok(result.timing.teardownMs >= 10);
  assert.ok(result.timing.totalMs >= result.timing.setupMs + result.timing.loopMs + result.timing.teardownMs - 1);
  assert.ok(result.timing.totalMs > result.durationMs);
  assert.equal(result.usage, undefined);
});

test('browser and teardown failures remain sanitized and teardown is counted', async () => {
  for (const options of [{ launchError: 'private-driver-token' }, { closeError: 'private-close-token' }]) {
    const fake = fakeBrowser(options);
    const result = await runBrowserGoal({ plan, decider: fake.decider, playwrightImpl: fake.driver });
    assert.equal(result.status, 'needs_host');
    assert.ok(['BROWSER_FAILED', 'BROWSER_CLOSE_FAILED'].includes(result.reason));
    assert.ok(!JSON.stringify(result).includes('private-')); assert.ok(result.timing.totalMs >= 0);
  }
});

test('CLI goal validates plan before attempting to read an explicit missing env file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-goal-cli-'));
  try {
    const planFile = join(directory, 'plan.json'); await writeFile(planFile, JSON.stringify({ ...plan, api: { fetchImpl: 'private-value' } }));
    const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--', cli, 'goal', '--plan', planFile, '--env-file', join(directory, 'missing.env')], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' }, timeout: 10000 });
    assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).reason, 'INVALID_API_OPTIONS');
    assert.ok(!result.stdout.includes('private-value'));
    const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', timeout: 10000 });
    assert.ok(JSON.parse(help.stdout).commands.some(command => command.startsWith('goal ')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one session rejects concurrent workflow and goal invocations before a second provider call', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const session = await createCuaSession({ apiKey: 'offline', maxCalls: 1, fetchImpl: async (_url, request) => {
    requests++; entered(); await waiting;
    const body = JSON.parse(request.body);
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 2 }, answers: { operation: answer(body.questions.operation.criteria, 'DONE') } }) };
  } });
  const target = { getObservation: async () => ({ text: 'Guide ready', url: 'https://example.com/guide', elements: [] }), click: async () => {} };
  const first = session.goal({ ...plan, target }); await started;
  try {
    const concurrent = await session.workflow({ target: { getAXState: async () => '0 button Open', click: async () => {} }, goal: 'Open', steps: [{ instruction: 'Open', action: 'click', expect: { textIncludes: 'Missing' } }] });
    assert.equal(concurrent.reason, 'SESSION_BUSY'); assert.equal(requests, 1);
  } finally { release(); }
  assert.equal((await first).status, 'completed'); assert.equal(session.stats().calls, 1);
});

test('live-mode integration passes bounded API options to a fake transport and meters completion calls', async () => {
  const savedFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, request) => {
    requests++; const body = JSON.parse(request.body);
    const done = body.state.observation.text.includes('Guide ready');
    const answers = { operation: answer(body.questions.operation.criteria, done ? 'DONE' : 'open') };
    if (!done) answers.target_open = answer(body.questions.target_open.criteria, 'e_0');
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 7 }, answers }) };
  };
  try {
    const fake = fakeBrowser();
    const result = await runBrowserGoal({ plan, apiKey: 'offline-only', playwrightImpl: fake.driver });
    assert.equal(result.status, 'completed'); assert.equal(result.mode, 'live-jev');
    assert.equal(result.usage.calls, 2); assert.equal(result.usage.inputTokens, 14);
    assert.equal(result.apiLimits.timeoutMs, 5000); assert.equal(result.apiLimits.maxCalls, plan.maxSteps + 3);
    const limited = fakeBrowser();
    const stopped = await runBrowserGoal({ plan: { ...plan, api: { maxCalls: 1, timeoutMs: 3000, maxInputBytes: 12000, minConfidence: 0.8, minMargin: 0.2 } }, apiKey: 'offline-only', playwrightImpl: limited.driver });
    assert.equal(stopped.reason, 'CALL_BUDGET_EXHAUSTED'); assert.equal(stopped.usage.calls, 1);
    assert.equal(requests, 3); assert.equal(limited.events.filter(([event]) => event === 'click').length, 1);
  } finally { globalThis.fetch = savedFetch; }
});
