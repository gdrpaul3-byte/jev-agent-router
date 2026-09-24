import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-session-secret-for-test-4242';
const REPORT = 'Set search value to "guide" (previous: "")';
const OVERSIZED = 'x'.repeat(1000001);
const stop = reason => ({ status: 'needs_host', reason });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const tick = () => new Promise(resolve => setImmediate(resolve));
// The CLI dates a raw directory by its oldest file. File times and Date.now() can differ by a clock tick on
// Windows, so files that must be newer than a proposal or an authorization are written after this pause.
const settle = () => pause(50);

async function subject() {
  let value;
  try { value = await import('../src/claude-chrome-session.mjs'); }
  catch { assert.fail('The Claude Chrome session ledger module must exist'); }
  return value;
}
// Module-level fault injection. A second instance of the session module (its URL carries a query) imports a
// wrapper of node:fs/promises whose calls a test can intercept through `hooks[name](real, ...args)`. The normal
// instance and every other module keep the real fs, and the hooks are removed when the test ends.
const INJECTED = 'claude-chrome-session.mjs?fs-injection';
let injectedModule;
async function injectedSubject(t, hooks = {}) {
  if (!injectedModule) {
    const names = Object.keys(realFs).filter(name => typeof realFs[name] === 'function');
    const source = [`import * as fs from 'node:fs/promises';`,
      'const via = name => (...args) => { const hook = globalThis.__jevSessionFs?.[name]; return hook ? hook(fs[name], ...args) : fs[name](...args); };',
      ...names.map(name => `export const ${name} = via(${JSON.stringify(name)});`), 'export const constants = fs.constants;'].join('\n');
    const url = `data:text/javascript,${encodeURIComponent(source)}`;
    registerHooks({ resolve: (specifier, context, next) => specifier === 'node:fs/promises' && context.parentURL?.endsWith(INJECTED)
      ? { url, format: 'module', shortCircuit: true } : next(specifier, context) });
    injectedModule = await import(new URL(`../src/${INJECTED}`, import.meta.url).href);
  }
  globalThis.__jevSessionFs = hooks;
  t.after(() => { delete globalThis.__jevSessionFs; });
  return injectedModule;
}
const fsError = (code, message = `simulated ${code}`) => Object.assign(new Error(message), { code });
// A process that has already exited: process.kill(pid, 0) reports ESRCH for it.
function deadPid() {
  const done = spawnSync(process.execPath, ['--version'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(done.status, 0);
  return done.pid;
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-claude-session-'));
  // Windows scanners can hold a just-written file for a moment; retry instead of failing cleanup with ENOTEMPTY.
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}
const plan = (overrides = {}) => ({
  goal: 'Search the public guide, then open it.', allowedOrigins: ['https://example.com'],
  actions: [
    { id: 'query', action: 'typeText', description: 'Fill the search box', text: 'guide', target: { roles: ['textbox'], nameEquals: 'Search' } },
    { id: 'requery', action: 'typeText', description: 'Replace the query', text: 'guides', target: { roles: ['textbox'], nameEquals: 'Search' } },
    { id: 'search', action: 'click', description: 'Search after the complete query is entered', target: { roles: ['button'], nameEquals: 'Search' } },
  ],
  completion: { textIncludes: 'Guide contents' }, ...overrides,
});
const SEARCH = ['textbox "Search" [ref_1] type="search"', 'button "Search" [ref_2]'];
// Verbatim shapes of one tabs_context_mcp / read_page (filter "interactive") / get_page_text batch.
const page = ({ url = 'https://example.com/', title = 'Guides', text = 'Search the guides', lines = SEARCH, tabId = 12 } = {}) => ({ tabId,
  tabsContext: `${JSON.stringify({ availableTabs: [{ tabId: 12, title, url }], selectedTabId: 12 })}\n\nTab Context:\n- Available tabs:\n  • tabId 12: "${title}" (${url})`,
  readPage: `${lines.join('\n')}\n\nViewport: 1920x945`, pageText: `Title: ${title}\nURL: ${url}\n---\n${text}` });
// read_page with ref_id prints the referenced element itself first, at depth 0. Raw authorize and typeText verify need it.
const lineOf = (raw, ref) => raw.readPage.split('\n').find(line => line.includes(`[${ref}]`)).trimStart();
const checked = (raw, ref, line = lineOf(raw, ref)) => ({ ...raw, refCheck: `${line}\n\nViewport: 1920x945` });
const GUIDE = { url: 'https://example.com/guide', title: 'Guide', text: 'Guide contents', lines: ['link "Back to search" [ref_7] href="/"'] };
const RESULTS = { text: 'Search the guides\n1 result', lines: [...SEARCH, 'link "Guide result" [ref_3] href="/guide"'] };
const envelope = observedAtEpochMs => ({ source: 'claude-in-chrome', observedAtEpochMs, tab: { id: 12, url: 'https://example.com/', title: 'Guides' }, text: 'Search the guides',
  elements: [{ ref: 'ref_1', role: 'textbox', name: 'Search', description: 'type=search', editable: true, visible: true }, { ref: 'ref_2', role: 'button', name: 'Search', visible: true }] });
const HASH = /^[a-f0-9]{64}$/;

const answer = (choice, keys, confidence) => ({ type: 'choice', choice, confidence,
  probabilities: Object.fromEntries(keys.map(key => [key, keys.length === 1 ? 1 : key === choice ? 0.98 : 0.02 / (keys.length - 1)])) });
// Each scripted step answers one JEV request using the option keys that request actually offered.
function jev(script = []) {
  const bodies = [];
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(request.body); bodies.push(body);
    if (!script.length) assert.fail('unexpected JEV request');
    const [operation, target = 'NONE', operationConfidence = 0.99, targetConfidence = 0.99] = script.shift();
    return new Response(JSON.stringify({ model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(body.questions).map(([key, { criteria }]) => [key, key === 'operation'
        ? answer(operation, Object.keys(criteria), operationConfidence)
        : answer(key === `target_${operation}` ? target : 'NONE', Object.keys(criteria), targetConfidence)])) }), { status: 200 });
  };
  return { fetchImpl, bodies, script };
}

async function session(t, { input = {}, script = [], api } = {}) {
  api ??= await subject();
  const mock = jev(script), dir = await temporary(t);
  const sessionDir = join(dir, 'session'), clock = { now: 1000 }, now = () => clock.now;
  const started = await api.startClaudeChromeSession({ plan: plan(), ...input }, { sessionDir, now });
  // Every command is a separate call, one simulated second after the previous one.
  const run = (command, body = {}, options = {}) => { clock.now += 1000;
    return api.runClaudeChromeSession(command, body, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl, now, ...options }); };
  const ledgerText = () => readFile(join(sessionDir, 'session.json'), 'utf8');
  return { api, dir, sessionDir, clock, now, mock, started, run, ledgerText, ledger: async () => JSON.parse(await ledgerText()) };
}
async function typed(s, raw = page()) {
  s.mock.script.push(['query', 'e_0']);
  assert.equal((await s.run('decide', { raw })).status, 'proposed');
  assert.equal((await s.run('authorize', { raw: checked(raw, 'ref_1') })).status, 'authorized');
  assert.equal((await s.run('verify', { raw: checked(raw, 'ref_1'), toolResult: REPORT })).inputEvidence, 'tool_report');
}
const sent = s => s.mock.bodies.at(-1).state.observation.elements;

test('start creates one private ledger in a new directory and never reuses an existing one', async t => {
  const s = await session(t);
  assert.deepEqual(s.started, { status: 'started', session: { status: 'active', calls: 0, maxCalls: 15, remainingMs: 60000, history: [], pending: null,
    usage: { requests: 0, knownInputTokens: 0, knownUsageUsd: 0, estimatedJevUsd: 0 } } });
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  const before = await s.ledgerText();
  assert.deepEqual(await s.api.startClaudeChromeSession({ plan: plan({ goal: 'Another goal' }) }, { sessionDir: s.sessionDir }), stop('SESSION_EXISTS'));
  assert.equal(await s.ledgerText(), before);
  const empty = join(s.dir, 'empty'); await mkdir(empty);
  assert.deepEqual(await s.api.startClaudeChromeSession({ plan: plan() }, { sessionDir: empty }), stop('SESSION_EXISTS'));
  assert.deepEqual(await readdir(empty), []);
  const nested = join(s.dir, 'a', 'b', 'session');
  const wide = await s.api.startClaudeChromeSession({ plan: plan({ maxSteps: 60, maxDurationMs: 120000 }), maxCalls: 7, api: { timeoutMs: 2000 } }, { sessionDir: nested, now: () => 5000 });
  assert.deepEqual([wide.session.maxCalls, wide.session.remainingMs], [7, 120000]);
  const ledger = JSON.parse(await readFile(join(nested, 'session.json'), 'utf8'));
  assert.deepEqual([ledger.createdAtEpochMs, ledger.deadlineEpochMs, ledger.api, ledger.inputs, ledger.pending], [5000, 125000, { timeoutMs: 2000 }, [], null]);
  assert.equal((await s.api.startClaudeChromeSession({ plan: plan({ maxSteps: 60 }) }, { sessionDir: join(s.dir, 'default') })).session.maxCalls, 50);
});

test('start rejects invalid plans, call budgets, API options and directories without creating anything', async t => {
  const api = await subject(), dir = await temporary(t), sessionDir = join(dir, 'session');
  const bad = [
    [{}, 'INVALID_PLAN'], [null, 'INVALID_PLAN'],
    [{ plan: plan({ allowedOrigins: undefined }) }, 'INVALID_PLAN'],
    [{ plan: plan({ allowedOrigins: ['https://example.com/path'] }) }, 'INVALID_PLAN'],
    [{ plan: plan({ actions: [{ id: 'enter', action: 'pressKey', key: 'Enter', description: 'Submit the form' }] }) }, 'INVALID_PLAN'],
    ...[0, -1, 1.5, 1001, '3'].map(maxCalls => [{ plan: plan(), maxCalls }, 'INVALID_MAX_CALLS']),
    ...[{ endpoint: 'https://evil.example' }, { timeoutMs: 0 }, { minConfidence: 0.5 }, { maxInputBytes: 1.5 }, []].map(options => [{ plan: plan(), api: options }, 'INVALID_API_OPTIONS']),
  ];
  for (const [input, reason] of bad) assert.deepEqual(await api.startClaudeChromeSession(input, { sessionDir }), stop(reason), JSON.stringify(input));
  for (const directory of [undefined, '', '  ']) assert.deepEqual(await api.startClaudeChromeSession({ plan: plan() }, { sessionDir: directory }), stop('INVALID_ARGUMENTS'));
  assert.deepEqual(await readdir(dir), []);
});

test('a fractional maxDurationMs gives an integer deadline and a readable ledger', async t => {
  // Round 1: a non-integer deadline made every later command return SESSION_INVALID.
  const s = await session(t, { input: { plan: plan({ maxDurationMs: 30000.5 }) }, script: [['query', 'e_0']] });
  assert.deepEqual([s.started.status, s.started.session.remainingMs], ['started', 30001]);
  assert.equal((await s.ledger()).deadlineEpochMs, 31001); // Math.ceil(1000 + 30000.5)
  const status = await s.run('status');
  assert.deepEqual([status.status, status.session.status, status.session.remainingMs], ['session', 'active', 29001]);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  s.clock.now = 30000; // The next command runs at 31000, one millisecond before the deadline.
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
  const late = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual([late.reason, late.session.status, late.session.remainingMs], ['TIMEOUT', 'needs_host', 0]);
});

test('a full workflow runs decide, authorize and verify from raw observations and completes only on proof', async t => {
  const s = await session(t, { script: [['query', 'e_0'], ['search', 'e_1'], ['DONE']] });
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.status, proposed.proposal.actionId, proposed.session.calls, proposed.session.pending], ['proposed', 'query', 1, 'proposed']);
  assert.deepEqual(proposed.proposal.target, { ref: 'ref_1', role: 'textbox', name: 'Search', description: 'type=search', editable: true });
  const typing = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.deepEqual([typing.status, typing.session.pending], ['authorized', 'authorized']);
  assert.deepEqual(typing.toolCall, { tool: 'form_input', arguments: { tabId: 12, ref: 'ref_1', value: 'guide' } });
  const input = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual([input.status, input.inputEvidence, input.completionMatches, input.session.pending], ['observed_after_action', 'tool_report', false, null]);
  assert.deepEqual(input.session.history, [{ actionId: 'query' }]);
  assert.equal((await s.run('decide', { raw: page() })).proposal.actionId, 'search');
  assert.equal(s.mock.bodies[0].state.observation.elements[0].value, undefined);
  // Round 3: the remembered value is marked as the input tool's report, not something the page showed.
  assert.deepEqual(s.mock.bodies[1].state.observation.elements[0],
    { ref: 0, role: 'textbox', name: 'Search', description: 'type=search', value: 'guide', valueSource: 'tool_report', editable: true });
  assert.deepEqual(s.mock.bodies[1].state.history, [{ actionId: 'query' }]);
  const click = await s.run('authorize', { raw: checked(page(), 'ref_2') });
  assert.deepEqual(click.toolCall, { tool: 'computer', arguments: { action: 'left_click', tabId: 12, ref: 'ref_2' } });
  // A click is verified from observable progress; no ref check or tool report is needed.
  const clicked = await s.run('verify', { raw: page(GUIDE) });
  assert.deepEqual([clicked.status, clicked.completionMatches, clicked.url, clicked.inputEvidence], ['observed_after_action', true, 'https://example.com/guide', undefined]);
  assert.deepEqual((await s.ledger()).inputs, []);
  const done = await s.run('decide', { raw: page(GUIDE) });
  assert.deepEqual([done.status, done.proposal.decision, done.proposal.target, done.session.calls], ['proposed', 'done', undefined, 3]);
  assert.deepEqual(s.mock.bodies[2].state.history, [{ actionId: 'query' }, { actionId: 'search' }]);
  const completed = await s.run('authorize', { raw: page(GUIDE) });
  assert.deepEqual([completed.status, completed.url], ['completed', 'https://example.com/guide']);
  const { usage, ...rest } = completed.session;
  assert.deepEqual(rest, { status: 'completed', calls: 3, maxCalls: 15, remainingMs: 52000, history: [{ actionId: 'query' }, { actionId: 'search' }], pending: null });
  assert.deepEqual([usage.requests, usage.knownInputTokens], [3, 300]);
  assert.ok(Math.abs(usage.estimatedJevUsd - 300 * 0.042 / 1000000) < 1e-15);
  for (const command of ['decide', 'authorize', 'verify']) assert.deepEqual((await s.run(command, { raw: page(GUIDE) })).reason, 'SESSION_COMPLETED');
  assert.equal(s.mock.bodies.length, 3);
});

test('each JEV request is counted and persisted before it is sent, even when it then fails', async t => {
  const s = await session(t);
  let persisted;
  const fetchImpl = async () => { persisted = JSON.parse(readFileSync(join(s.sessionDir, 'session.json'), 'utf8')).calls; throw new Error('connection reset'); };
  const result = await s.run('decide', { raw: page() }, { fetchImpl });
  assert.equal(persisted, 1);
  assert.deepEqual([result.status, result.reason, result.session.status, result.session.reason, result.session.calls], ['needs_host', 'REQUEST_FAILED', 'needs_host', 'REQUEST_FAILED', 1]);
  assert.equal(result.session.usage.requests, 1);
  assert.equal(result.session.usage.estimatedJevUsd, null); // Unknown cost is never reported as zero.
  assert.equal((await s.ledger()).calls, 1);
  assert.equal((await s.run('decide', { raw: page() })).reason, 'SESSION_STOPPED');
  assert.equal(s.mock.bodies.length, 0);
});

test('a request that never settles has spent budget, has unknown cost and holds a recorded lock until it is abandoned', async t => {
  const s = await session(t, { input: { api: { timeoutMs: 50 } } });
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  const startedAt = Date.now();
  const hanging = s.run('decide', { raw: page() }, { fetchImpl: () => { entered(); return new Promise(() => {}); } });
  let result;
  try {
    await reached;
    assert.equal((await s.ledger()).calls, 1);
    assert.ok((await readdir(s.sessionDir)).includes('.lock'));
    // The lock names its owner so a host can tell a live command from one that was killed.
    const owner = JSON.parse(await readFile(join(s.sessionDir, '.lock'), 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['command', 'pid', 'sinceEpochMs']);
    assert.deepEqual([owner.pid, owner.command], [process.pid, 'decide']);
    assert.ok(Number.isSafeInteger(owner.sinceEpochMs) && owner.sinceEpochMs >= startedAt && owner.sinceEpochMs <= Date.now());
    const status = await s.run('status');
    assert.deepEqual(status.session.locked, owner);
    // The POST was counted but its usage is not recorded yet: the estimate is unknown, never 0.
    assert.deepEqual([status.session.calls, status.session.usage.requests, status.session.usage.knownUsageUsd, status.session.usage.estimatedJevUsd], [1, 0, 0, null]);
    assert.deepEqual(await s.run('decide', { raw: page() }), { ...stop('SESSION_BUSY'), locked: owner });
  } finally { result = await hanging; }
  assert.deepEqual([result.reason, result.session.status, result.session.calls, result.session.usage.estimatedJevUsd], ['TIMEOUT', 'needs_host', 1, null]);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  assert.equal((await s.run('status')).session.locked, null);
  assert.equal(s.mock.bodies.length, 0);
});

test('the lock is held until the ledger write has completed', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  await s.run('decide', { raw: page() });
  const lockPath = join(s.sessionDir, '.lock'), ledgerPath = join(s.sessionDir, 'session.json');
  // Another reader of session.json (status, antivirus, sync) makes Windows refuse the replace for a while, so the write retries.
  let reader = await open(ledgerPath, 'r');
  let settled = false;
  const running = s.run('authorize', { raw: checked(page(), 'ref_1') }).finally(() => { settled = true; });
  const opened = Date.now();
  let sawLock = false, stage;
  try {
    for (;;) {
      if (reader && Date.now() - opened > 100) { await reader.close(); reader = undefined; }
      if (existsSync(lockPath)) sawLock = true;
      // The moment the lock is gone, the new state must already be on disk.
      else if (sawLock) { stage = JSON.parse(readFileSync(ledgerPath, 'utf8')).pending?.stage; break; }
      else if (settled) break;
      await tick();
    }
  } finally { await reader?.close(); }
  const result = await running;
  assert.ok(sawLock, 'the lock was never observed');
  assert.equal(stage, 'authorized');
  assert.equal(result.status, 'authorized');
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('two concurrent authorizations of one proposal never both succeed', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const { proposal } = await s.run('decide', { raw: page() });
  const epoch = proposal.createdAtEpochMs + 1000;
  const authorize = () => s.api.runClaudeChromeSession('authorize', { raw: checked(page(), 'ref_1') }, { sessionDir: s.sessionDir, now: () => epoch });
  // Holding session.json open delays the winner's write on Windows, widening any window where the lock is released early.
  const reader = await open(join(s.sessionDir, 'session.json'), 'r');
  const release = pause(100).then(() => reader.close());
  let settled = false;
  const first = authorize().finally(() => { settled = true; });
  const others = [];
  // An impatient host keeps retrying while the first authorization is still running.
  while (!settled) others.push(await authorize());
  others.push(await authorize());
  await release;
  const results = [await first, ...others];
  const winners = results.filter(result => result.status === 'authorized');
  assert.equal(winners.length, 1, JSON.stringify(results.map(result => result.reason ?? result.status)));
  for (const result of results.filter(item => item !== winners[0])) assert.ok(['SESSION_BUSY', 'ACTION_UNVERIFIED'].includes(result.reason), JSON.stringify(result));
  assert.equal(others.at(-1).reason, 'ACTION_UNVERIFIED');
  const { pending } = await s.ledger();
  assert.deepEqual([pending.stage, pending.authorization.authorizedAtEpochMs, pending.authorization.toolCall], ['authorized', winners[0].authorizedAtEpochMs, winners[0].toolCall]);
});

test('the call budget spans separate invocations; authorize and verify spend none of it', async t => {
  const s = await session(t, { input: { maxCalls: 2 } });
  await typed(s);
  s.mock.script.push(['search', 'e_1']);
  const second = await s.run('decide', { raw: page() });
  assert.deepEqual([second.status, second.session.calls], ['proposed', 2]);
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_2') })).status, 'authorized');
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).session.calls, 2);
  const exhausted = await s.run('decide', { raw: page(RESULTS) });
  assert.deepEqual([exhausted.reason, exhausted.session.status, exhausted.session.reason, exhausted.session.calls], ['CALL_BUDGET_EXHAUSTED', 'needs_host', 'CALL_BUDGET_EXHAUSTED', 2]);
  assert.equal(s.mock.bodies.length, 2);
  assert.equal((await s.run('decide', { raw: page(RESULTS) })).reason, 'SESSION_STOPPED');
});

test('the workflow deadline is shared by every command and stops the session with TIMEOUT', async t => {
  const s = await session(t, { input: { plan: plan({ maxDurationMs: 5000 }) }, script: [['query', 'e_0']] });
  assert.equal((await s.run('decide', { raw: page() })).session.remainingMs, 4000);
  s.clock.now = 5000; // The next command runs at the deadline.
  const late = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.deepEqual([late.reason, late.session.status, late.session.remainingMs, late.session.pending], ['TIMEOUT', 'needs_host', 0, 'proposed']);
  assert.equal((await s.run('decide', { raw: page() })).reason, 'SESSION_STOPPED');
  const early = await session(t, { input: { plan: plan({ maxDurationMs: 5000 }) } });
  early.clock.now = 5000;
  assert.equal((await early.run('decide', { raw: page() })).reason, 'TIMEOUT');
  assert.deepEqual([s.mock.bodies.length, early.mock.bodies.length, (await early.ledger()).calls], [1, 0, 0]);
});

test('an expired proposal is discarded, nothing runs, and the session stays active for a new decision', async t => {
  const s = await session(t, { input: { plan: plan({ maxDurationMs: 600000 }) }, script: [['query', 'e_0'], ['query', 'e_0']] });
  const { proposal } = await s.run('decide', { raw: page() });
  s.clock.now = proposal.createdAtEpochMs + 60000; // The next command runs 60001 ms after the proposal.
  const expired = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.deepEqual([expired.status, expired.reason, expired.toolCall], ['needs_host', 'PROPOSAL_EXPIRED', undefined]);
  assert.deepEqual([expired.session.status, expired.session.reason, expired.session.pending, expired.session.calls], ['active', undefined, null, 1]);
  const ledger = await s.ledger();
  assert.deepEqual([ledger.status, ledger.reason, ledger.pending, ledger.history], ['active', undefined, null, []]);
  // The discarded proposal can never be authorized later.
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).reason, 'NO_PENDING_PROPOSAL');
  assert.equal((await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT })).reason, 'NO_PENDING_ACTION');
  const again = await s.run('decide', { raw: page() });
  assert.deepEqual([again.status, again.session.calls, again.session.pending], ['proposed', 2, 'proposed']);
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
});

test('deciding while an authorized action is unverified is refused without a request or ledger change', async t => {
  const s = await session(t, { script: [['search', 'e_1']] });
  await s.run('decide', { raw: page() });
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_2') })).status, 'authorized');
  const before = await s.ledgerText();
  for (const command of ['decide', 'authorize']) {
    const result = await s.run(command, { raw: checked(page(), 'ref_2') });
    assert.deepEqual([result.reason, result.session.status, result.session.pending], ['ACTION_UNVERIFIED', 'active', 'authorized'], command);
  }
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 1);
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).status, 'observed_after_action');
});

test('authorize and verify require the matching pending stage and leave the ledger unchanged', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const before = await s.ledgerText();
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).reason, 'NO_PENDING_PROPOSAL');
  assert.equal((await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT })).reason, 'NO_PENDING_ACTION');
  assert.equal(await s.ledgerText(), before);
  await s.run('decide', { raw: page() });
  const proposed = await s.ledgerText();
  const early = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual([early.reason, early.session.status, early.session.pending], ['NO_PENDING_ACTION', 'active', 'proposed']);
  assert.equal(await s.ledgerText(), proposed);
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
});

test('observation input errors are recoverable: nothing is counted, consumed or changed', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const before = await s.ledgerText();
  for (const [command, input] of [['decide', { raw: page(), toolResult: REPORT }], ['authorize', { raw: page(), toolResult: REPORT }],
    ['decide', { raw: page(), toolResultAtEpochMs: 5 }], ['authorize', { raw: page(), toolResultAtEpochMs: 5 }],
    ['verify', { raw: page(), extra: true }], ['decide', null], ['observe', { raw: page() }], ['start', { plan: plan() }], ['unlock', {}]]) {
    assert.deepEqual(await s.run(command, input), stop('INVALID_ARGUMENTS'), `${command} ${JSON.stringify(input)}`);
  }
  for (const [input, reason] of [
    [{ raw: { ...page(), readPage: '<div>Search</div>\n\nViewport: 1920x945' } }, 'READ_PAGE_UNPARSED'],
    [{ raw: { ...page(), readPage: SEARCH.join('\n') } }, 'READ_PAGE_UNPARSED'],
    [{ raw: page({ lines: [...SEARCH, 'button "Again" [ref_2]'] }) }, 'READ_PAGE_DUPLICATE_REF'],
    [{ raw: page({ tabId: 13 }) }, 'TAB_NOT_FOUND'],
    [{ raw: { ...page(), pageText: 'Title: Guides\nURL: https://example.com/other\n---\nSearch the guides' } }, 'OBSERVATION_INCONSISTENT'],
    [{ raw: page({ lines: Array.from({ length: 201 }, (_, index) => `button "B${index}" [ref_${index}]`) }) }, 'TOO_MANY_CANDIDATES'],
    [{ raw: 'read_page output' }, 'RAW_OBSERVATION_INVALID'],
    [{ raw: { ...page(), observedAtEpochMs: -1 } }, 'RAW_OBSERVATION_INVALID'],
    [{ raw: { ...page(), observedAtEpochMs: 1.5 } }, 'RAW_OBSERVATION_INVALID'],
    [{}, 'INVALID_OBSERVATION'],
    [{ raw: page(), observation: envelope(1000) }, 'INVALID_OBSERVATION'],
    [{ observation: envelope(999999) }, 'INVALID_OBSERVATION'],
    [{ observation: { ...envelope(1000), elements: [{ ...envelope(1000).elements[0], visible: false }] } }, 'INVALID_OBSERVATION'],
    // Round 3: a value source is only ever 'tool_report', and only together with a string value.
    [{ observation: { ...envelope(1000), elements: [{ ...envelope(1000).elements[0], value: 'guide', valueSource: 'page' }] } }, 'INVALID_OBSERVATION'],
    [{ observation: { ...envelope(1000), elements: [{ ...envelope(1000).elements[0], valueSource: 'tool_report' }] } }, 'INVALID_OBSERVATION'],
  ]) {
    const result = await s.run('decide', input);
    assert.deepEqual([result.reason, result.session.status, result.session.calls], [reason, 'active', 0], reason);
  }
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 0);
  const { proposal } = await s.run('decide', { raw: page() });
  const pending = await s.ledgerText();
  for (const [input, reason] of [
    [{ observation: envelope(proposal.createdAtEpochMs) }, 'FRESH_OBSERVATION_REQUIRED'],
    // A raw capture time at or before the proposal is not a fresh observation.
    [{ raw: checked({ ...page(), observedAtEpochMs: proposal.createdAtEpochMs }, 'ref_1') }, 'FRESH_OBSERVATION_REQUIRED'],
    [{ raw: checked(page({ tabId: 13 }), 'ref_1') }, 'TAB_NOT_FOUND'],
    [{ raw: page() }, 'REF_CHECK_REQUIRED'],
    [{ raw: { ...checked(page(), 'ref_1'), observedAtEpochMs: '5000' } }, 'RAW_OBSERVATION_INVALID'],
  ]) {
    const result = await s.run('authorize', input);
    assert.deepEqual([result.reason, result.session.status, result.session.pending], [reason, 'active', 'proposed'], reason);
  }
  assert.equal(await s.ledgerText(), pending);
  const authorized = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.equal(authorized.status, 'authorized');
  const waiting = await s.ledgerText();
  for (const [input, reason] of [
    [{ observation: envelope(authorized.authorizedAtEpochMs), toolResult: REPORT }, 'FRESH_OBSERVATION_REQUIRED'],
    [{ raw: checked({ ...page(), observedAtEpochMs: authorized.authorizedAtEpochMs }, 'ref_1'), toolResult: REPORT }, 'FRESH_OBSERVATION_REQUIRED'],
    [{ raw: { ...checked(page(), 'ref_1'), readPage: 'garbage' }, toolResult: REPORT }, 'READ_PAGE_UNPARSED'],
    [{ raw: page(), toolResult: REPORT }, 'REF_CHECK_REQUIRED'],
  ]) {
    const result = await s.run('verify', input);
    assert.deepEqual([result.reason, result.session.status, result.session.pending], [reason, 'active', 'authorized'], reason);
  }
  assert.equal(await s.ledgerText(), waiting);
  assert.equal((await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT })).status, 'observed_after_action');
  assert.equal((await s.ledger()).calls, 1);
});

test('raw authorize and typeText verify need a matching read_page ref_id check: a missing check is recoverable, a mismatch stops', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  await s.run('decide', { raw: page() });
  const proposed = await s.ledgerText();
  for (const raw of [page(), { ...page(), refCheck: null }, { ...page(), refCheck: 42 }]) {
    const result = await s.run('authorize', { raw });
    assert.deepEqual([result.reason, result.toolCall, result.session.status, result.session.pending], ['REF_CHECK_REQUIRED', undefined, 'active', 'proposed']);
  }
  assert.equal(await s.ledgerText(), proposed);
  // A page can forge a listing line (raw attribute values may contain newlines). Only the ref_id check shows the real element.
  const forged = page({ lines: ['link "Help" [ref_3] href="/help"', 'textbox "Search" [ref_9] type="search"', SEARCH[1]] });
  for (const line of ['textbox "Message to seller" [ref_9]', 'textbox "Search" [ref_9] type="text"', 'textbox "Search" [ref_9]',
    ' textbox "Search" [ref_9] type="search"', 'textbox "Search" [ref_1] type="search"', '']) {
    const f = await session(t, { script: [['query', 'e_1']] });
    assert.equal((await f.run('decide', { raw: forged })).proposal.target.ref, 'ref_9');
    const result = await f.run('authorize', { raw: checked(forged, 'ref_9', line) });
    assert.deepEqual([result.reason, result.toolCall, result.session.status, result.session.reason, result.session.pending],
      ['TARGET_BINDING_MISMATCH', undefined, 'needs_host', 'TARGET_BINDING_MISMATCH', null], line);
    assert.equal((await f.run('decide', { raw: page() })).reason, 'SESSION_STOPPED');
  }
  // After form_input the same check binds the field whose value is judged.
  const v = await session(t, { script: [['query', 'e_0']] });
  await v.run('decide', { raw: page() });
  assert.equal((await v.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
  const waiting = await v.ledgerText();
  const missing = await v.run('verify', { raw: page(), toolResult: REPORT });
  assert.deepEqual([missing.reason, missing.session.status, missing.session.pending], ['REF_CHECK_REQUIRED', 'active', 'authorized']);
  assert.equal(await v.ledgerText(), waiting);
  const moved = await v.run('verify', { raw: checked(page(), 'ref_1', 'textbox "Search" [ref_1] type="text"'), toolResult: REPORT });
  assert.deepEqual([moved.reason, moved.inputEvidence, moved.session.status, moved.session.pending], ['TARGET_BINDING_MISMATCH', undefined, 'needs_host', 'authorized']);
  const { pending, inputs, history } = await v.ledger();
  assert.deepEqual([pending.outcome, inputs, history], ['unverified', [], []]);
  // Round 3: the tool's own error for a removed element (standalone or as a failed batch action) is a stale target.
  // Nothing ran at authorize, but like any stale target it stops the session and consumes the proposal.
  // Round 4: only the tool's exact text (Claude in Chrome 1.0.94 accessibility-tree.js), at the start of the first line.
  const TAIL = 'It may have been removed from the page. Use read_page without ref_id to get the current page state.';
  for (const refCheck of [`Element with ref_id 'ref_1' not found. ${TAIL}`,
    `actions[3] (read_page) failed: Element with ref_id 'ref_1' no longer exists. ${TAIL}`,
    `[read_page]Error: Element with ref_id 'ref_1' not found. ${TAIL}`]) {
    const gone = await session(t, { script: [['query', 'e_0']] });
    await gone.run('decide', { raw: page() });
    const result = await gone.run('authorize', { raw: { ...page(), refCheck } });
    assert.deepEqual([result.reason, result.toolCall, result.session.status, result.session.reason, result.session.pending],
      ['STALE_TARGET', undefined, 'needs_host', 'STALE_TARGET', null], refCheck);
    // After form_input the same error leaves the action unverified, never replayed.
    const typing = await session(t, { script: [['query', 'e_0']] });
    await typing.run('decide', { raw: page() });
    assert.equal((await typing.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
    const lost = await typing.run('verify', { raw: { ...page(), refCheck }, toolResult: REPORT });
    assert.deepEqual([lost.reason, lost.inputEvidence, lost.session.status, lost.session.pending], ['STALE_TARGET', undefined, 'needs_host', 'authorized'], refCheck);
    assert.deepEqual([(await typing.ledger()).pending.outcome, (await typing.ledger()).inputs], ['unverified', []]);
  }
  // Round 4: an error for another ref, a cut-off error, or an element line quoting the error is not the tool
  // reporting this target gone. None of them binds the target, so authorize still stops, with a binding mismatch.
  for (const refCheck of [`Element with ref_id 'ref_2' not found. ${TAIL}`, "Element with ref_id 'ref_1' no longer exists",
    `generic "Element with ref_id 'ref_1' not found." [ref_1]\n\nViewport: 1920x945`, `Note: Element with ref_id 'ref_1' not found. ${TAIL}`]) {
    const other = await session(t, { script: [['query', 'e_0']] });
    await other.run('decide', { raw: page() });
    const result = await other.run('authorize', { raw: { ...page(), refCheck } });
    assert.deepEqual([result.reason, result.toolCall, result.session.status, result.session.reason, result.session.pending],
      ['TARGET_BINDING_MISMATCH', undefined, 'needs_host', 'TARGET_BINDING_MISMATCH', null], refCheck);
  }
});

test('an unreadable env file is a recoverable configuration error that spends no budget', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const before = await s.ledgerText();
  const result = await s.run('decide', { raw: page() }, { apiKey: '', envFile: join(s.dir, 'missing.env') });
  assert.deepEqual([result.reason, result.session.status, result.session.calls], ['JEV_CONFIG_READ_ERROR', 'active', 0]);
  assert.equal(await s.ledgerText(), before);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
});

test('a missing or malformed API key before any request leaves the session usable like other key configuration errors', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  await writeFile(join(s.dir, 'no-key.env'), 'OTHER_SETTING=1\n');
  const before = await s.ledgerText();
  for (const [options, reason] of [[{ apiKey: '' }, 'MISSING_API_KEY'], [{ apiKey: '', envFile: join(s.dir, 'no-key.env') }, 'MISSING_API_KEY'],
    [{ apiKey: 'sk-dummy\nX-Injected: 1' }, 'INVALID_CONFIGURATION']]) {
    const result = await s.run('decide', { raw: page() }, options);
    assert.deepEqual([result.reason, result.session.calls, result.session.status, result.session.pending], [reason, 0, 'active', null], reason);
  }
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 0);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
});

test('decider input limits hit before any request (INPUT_TOO_LARGE, TOO_MANY_OPTIONS) leave the ledger unchanged', async t => {
  // Round 4: like key errors, the decider's own pre-request refusals spend nothing and stop nothing.
  const small = await session(t, { input: { api: { maxInputBytes: 200 } } });
  const before = await small.ledgerText();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await small.run('decide', { raw: page() });
    assert.deepEqual([result.status, result.reason, result.proposal, result.session.status, result.session.reason, result.session.calls, result.session.pending, result.session.usage.requests],
      ['needs_host', 'INPUT_TOO_LARGE', undefined, 'active', undefined, 0, null, 0]);
    assert.equal(result.session.usage.estimatedJevUsd, 0);
  }
  assert.equal(await small.ledgerText(), before);
  assert.deepEqual(await readdir(small.sessionDir), ['session.json']);
  const status = await small.run('status');
  assert.deepEqual([status.session.status, status.session.calls, status.session.history], ['active', 0, []]);
  assert.equal(small.mock.bodies.length, 0);
  // 200 eligible targets for one action exceed the option limit of a JEV question (the observation itself is within limits).
  const crowded = page({ lines: Array.from({ length: 200 }, (_, index) => `button "Search" [ref_${index + 1}]`) });
  const s = await session(t, { script: [['query', 'e_0']] });
  const unchanged = await s.ledgerText();
  const result = await s.run('decide', { raw: crowded });
  assert.deepEqual([result.reason, result.session.status, result.session.calls, result.session.pending], ['TOO_MANY_OPTIONS', 'active', 0, null]);
  assert.equal(await s.ledgerText(), unchanged);
  assert.equal(s.mock.bodies.length, 0);
  // The session is still usable for a page within the limits.
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.status, proposed.session.calls], ['proposed', 1]);
});

test('a low-confidence JEV decision stops the session with sanitized diagnostics mapped to observed refs', async t => {
  for (const [step, expected] of [[['query', 'e_0', 0.6], { head: 'OPERATION', choice: 'query', confidence: 0.6 }], [['query', 'e_0', 0.99, 0.6], { head: 'TARGET', choice: 'ref_1', confidence: 0.6 }]]) {
    const s = await session(t, { script: [step] });
    const result = await s.run('decide', { raw: page() });
    assert.deepEqual([result.status, result.reason, result.detail, result.proposal], ['needs_host', 'LOW_CONFIDENCE', expected.head, undefined]);
    const { margin, ...diagnostics } = result.diagnostics;
    assert.deepEqual(diagnostics, expected); assert.ok(margin > 0.9 && margin <= 1);
    assert.deepEqual([result.session.status, result.session.reason, result.session.calls, result.session.pending], ['needs_host', 'LOW_CONFIDENCE', 1, null]);
    for (const command of ['decide', 'authorize', 'verify']) assert.equal((await s.run(command, { raw: page() })).reason, 'SESSION_STOPPED');
    assert.equal((await s.run('status')).session.reason, 'LOW_CONFIDENCE');
    assert.equal(s.mock.bodies.length, 1);
  }
});

test('an existing lock refuses every mutating command, is shown by status and is never removed by the refused call', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const lock = join(s.sessionDir, '.lock'); await writeFile(lock, 'held by another process');
  const before = await s.ledgerText();
  for (const [command, input] of [['decide', { raw: page() }], ['authorize', { raw: checked(page(), 'ref_1') }], ['verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT }]]) {
    assert.deepEqual(await s.run(command, input), { ...stop('SESSION_BUSY'), locked: { unknown: true } }, command);
  }
  assert.equal(await readFile(lock, 'utf8'), 'held by another process');
  // A readable owner record is reported as it is.
  const owner = { pid: 2147483000, command: 'verify', sinceEpochMs: 1234 };
  await writeFile(lock, JSON.stringify(owner));
  assert.deepEqual(await s.run('decide', { raw: page() }), { ...stop('SESSION_BUSY'), locked: owner });
  const status = await s.run('status');
  assert.deepEqual([status.session.status, status.session.locked], ['active', owner]);
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 0);
  await rm(lock);
  assert.equal((await s.run('status')).session.locked, null);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('unlock never removes the lock of a running process, of another pid or an unreadable lock', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const lock = join(s.sessionDir, '.lock'), unlock = pid => s.api.unlockClaudeChromeSession({ sessionDir: s.sessionDir, pid });
  assert.deepEqual(await unlock(process.pid), stop('NOT_LOCKED'));
  assert.deepEqual(await s.api.unlockClaudeChromeSession({ sessionDir: join(s.dir, 'missing'), pid: process.pid }), stop('NOT_LOCKED'));
  const live = { pid: process.pid, command: 'verify', sinceEpochMs: 1234 };
  await writeFile(lock, JSON.stringify(live));
  assert.deepEqual(await unlock(process.pid), { ...stop('LOCK_OWNER_RUNNING'), locked: live });
  assert.deepEqual(await unlock(process.pid + 1), { ...stop('LOCK_OWNER_MISMATCH'), locked: live });
  // The CLI checks liveness from its own process: the test process is still running.
  assert.deepEqual(cli(['unlock', '--session', s.sessionDir, '--pid', String(process.pid)]), { code: 2, output: { ...stop('LOCK_OWNER_RUNNING'), locked: live } });
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), live);
  // Round 3: an ownerless lock (empty or unparseable, e.g. from an older release) names no pid, so no pid can
  // claim it: LOCK_OWNER_UNKNOWN with its age. Only --pid 0 may remove it, and only when old (see below).
  for (const content of ['', 'not json', '42']) {
    await writeFile(lock, content);
    for (const pid of [process.pid, 4242]) {
      const refused = await unlock(pid);
      assert.deepEqual([refused.status, refused.reason, refused.locked], ['needs_host', 'LOCK_OWNER_UNKNOWN', { unknown: true }], `${pid} ${content}`);
      assert.ok(Number.isSafeInteger(refused.ageMs) && refused.ageMs >= 0 && refused.ageMs < 600000, JSON.stringify(refused));
    }
    assert.equal(await readFile(lock, 'utf8'), content);
  }
  // A record without a numeric pid is not an owner that can be checked. Round 4 reads the owner once, in the same
  // guarded step as the age, and treats such a record as ownerless (round 3: LOCK_OWNER_MISMATCH). No pid can claim it.
  for (const content of [JSON.stringify({ command: 'decide' }), JSON.stringify({ pid: String(process.pid) })]) {
    await writeFile(lock, content);
    const refused = await unlock(process.pid);
    assert.deepEqual([refused.status, refused.reason, refused.locked], ['needs_host', 'LOCK_OWNER_UNKNOWN', { unknown: true }], content);
    assert.ok(Number.isSafeInteger(refused.ageMs) && refused.ageMs >= 0 && refused.ageMs < 600000, JSON.stringify(refused));
    assert.equal(await readFile(lock, 'utf8'), content);
  }
  // pid 0 is now valid (ownerless-lock recovery); negative, fractional, unsafe and non-numeric pids are not.
  for (const args of [undefined, {}, { sessionDir: s.sessionDir }, { sessionDir: s.sessionDir, pid: -5 }, { sessionDir: s.sessionDir, pid: 2 ** 53 },
    { sessionDir: s.sessionDir, pid: NaN }, { sessionDir: s.sessionDir, pid: null },
    { sessionDir: s.sessionDir, pid: 1.5 }, { sessionDir: s.sessionDir, pid: String(process.pid) }, { pid: process.pid }, { sessionDir: ' ', pid: process.pid }]) {
    assert.deepEqual(await s.api.unlockClaudeChromeSession(args), stop('INVALID_ARGUMENTS'), JSON.stringify(args));
  }
  assert.ok(existsSync(lock));
  assert.equal(s.mock.bodies.length, 0);
});

// Runs one real session decide in its own process and exits the moment the JEV request leaves it,
// the way a host timeout or Ctrl+C kills the CLI: no finally block, no usage record.
const CRASHING_DECIDE = `import { readFileSync } from 'node:fs';
const [moduleUrl, sessionDir, inputFile] = process.argv.slice(2);
const { runClaudeChromeSession } = await import(moduleUrl);
await runClaudeChromeSession('decide', JSON.parse(readFileSync(inputFile, 'utf8')), { sessionDir, apiKey: 'dummy-key-not-a-secret',
  fetchImpl: () => process.exit(9) });
`;

test('a command killed during its request leaves a recorded lock that only an explicit unlock of the dead owner removes', async t => {
  const api = await subject(), dir = await temporary(t), sessionDir = join(dir, 'session'), mock = jev([['query', 'e_0']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  const script = join(dir, 'crashing-decide.mjs'), input = join(dir, 'input.json');
  await writeFile(script, CRASHING_DECIDE); await writeFile(input, JSON.stringify({ raw: page() }));
  const moduleUrl = pathToFileURL(join(ROOT, 'src', 'claude-chrome-session.mjs')).href;
  const crashed = spawnSync(process.execPath, [script, moduleUrl, sessionDir, input], { encoding: 'utf8', timeout: 30000 });
  assert.equal(crashed.status, 9, crashed.stderr);
  const lock = join(sessionDir, '.lock'), owner = JSON.parse(await readFile(lock, 'utf8'));
  assert.deepEqual([owner.pid, owner.command, Number.isSafeInteger(owner.sinceEpochMs)], [crashed.pid, 'decide', true]);
  const status = await api.runClaudeChromeSession('status', {}, { sessionDir });
  // The request was counted before it left; its cost is unknown, never 0.
  assert.deepEqual([status.session.locked, status.session.status, status.session.calls, status.session.usage.requests, status.session.usage.estimatedJevUsd],
    [owner, 'active', 1, 0, null]);
  const decide = () => api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl });
  assert.deepEqual(await decide(), { ...stop('SESSION_BUSY'), locked: owner });
  assert.deepEqual(await api.unlockClaudeChromeSession({ sessionDir, pid: crashed.pid + 1 }), { ...stop('LOCK_OWNER_MISMATCH'), locked: owner });
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), owner);
  const unlocked = cli(['unlock', '--session', sessionDir, '--pid', String(crashed.pid)]);
  assert.deepEqual(unlocked, { code: 0, output: { status: 'unlocked', removed: owner } });
  assert.deepEqual(await readdir(sessionDir), ['session.json']);
  assert.deepEqual(cli(['unlock', '--session', sessionDir, '--pid', String(crashed.pid)]), { code: 2, output: stop('NOT_LOCKED') });
  const next = await decide();
  assert.deepEqual([next.status, next.session.calls, next.session.usage.requests, next.session.usage.estimatedJevUsd], ['proposed', 2, 1, null]);
  assert.equal(mock.bodies.length, 1);
});

test('unlock with pid 0 removes an ownerless lock only once it is older than ten minutes, never a recorded owner', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const lock = join(s.sessionDir, '.lock'), WRITTEN = 1700000000000;
  const unlock = (pid, at) => s.api.unlockClaudeChromeSession({ sessionDir: s.sessionDir, pid, now: () => at });
  const ownerless = async content => { await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000); };
  assert.deepEqual(await unlock(0, WRITTEN), stop('NOT_LOCKED'));
  // An empty lock is what a process killed between creating and writing a lock left behind in older releases.
  for (const content of ['', '{"pid":', 'not json', '42', 'null', '[]']) {
    await ownerless(content);
    for (const [pid, at] of [[0, WRITTEN + 599999], [0, WRITTEN - 5000], [process.pid, WRITTEN + 3600000], [4242, WRITTEN + 3600000]]) {
      assert.deepEqual(await unlock(pid, at), { ...stop('LOCK_OWNER_UNKNOWN'), locked: { unknown: true }, ageMs: Math.max(0, at - WRITTEN) }, `${pid} ${at} ${content}`);
      assert.equal(await readFile(lock, 'utf8'), content);
    }
    assert.deepEqual(await unlock(0, WRITTEN + 600000), { status: 'unlocked', removed: { unknown: true } }, content);
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  }
  // A recorded owner is never released by pid 0, however old its lock is.
  for (const owner of [{ pid: 4242, command: 'decide', sinceEpochMs: 1 }, { pid: process.pid, command: 'verify', sinceEpochMs: 1 }]) {
    await ownerless(JSON.stringify(owner));
    assert.deepEqual(await unlock(0, WRITTEN + 86400000), { ...stop('LOCK_OWNER_MISMATCH'), locked: owner });
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), owner);
  }
  // A lock that cannot be read at all is left for the host to inspect.
  await rm(lock); await mkdir(lock);
  for (const pid of [0, process.pid]) assert.deepEqual(await unlock(pid, WRITTEN + 86400000), stop('LOCK_UNREADABLE'));
  assert.deepEqual(await s.run('decide', { raw: page() }), { ...stop('SESSION_BUSY'), locked: { unknown: true } });
  await rm(lock, { recursive: true });
  // The CLI judges the age with the real clock.
  await writeFile(lock, '');
  const young = cli(['unlock', '--session', s.sessionDir, '--pid', '0']);
  assert.deepEqual([young.code, young.output.reason, young.output.locked], [2, 'LOCK_OWNER_UNKNOWN', { unknown: true }]);
  assert.ok(young.output.ageMs >= 0 && young.output.ageMs < 600000, JSON.stringify(young.output));
  assert.equal(await readFile(lock, 'utf8'), '');
  const old = (Date.now() - 660000) / 1000;
  await utimes(lock, old, old);
  assert.deepEqual(cli(['unlock', '--session', s.sessionDir, '--pid', '0']), { code: 0, output: { status: 'unlocked', removed: { unknown: true } } });
  assert.deepEqual(cli(['unlock', '--session', s.sessionDir, '--pid', '0']), { code: 2, output: stop('NOT_LOCKED') });
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('unlock re-reads the lock right before removing it and leaves a lock that changed meanwhile', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api });
  const lock = join(s.sessionDir, '.lock'), dead = deadPid(), WRITTEN = 1700000000000;
  const owner = { pid: dead, command: 'decide', sinceEpochMs: 1 }, newer = { pid: process.pid, command: 'authorize', sinceEpochMs: Date.now() };
  const unlock = (pid, at = WRITTEN + 600000) => api.unlockClaudeChromeSession({ sessionDir: s.sessionDir, pid, now: () => at });
  // Another command takes the lock after unlock inspected the old one (the old lock removed, a new one created).
  const replaceBeforeRead = n => { let reads = 0; hooks.readFile = async (real, path, ...rest) => {
    if (resolve(String(path)) === lock && ++reads === n) await writeFile(lock, JSON.stringify(newer));
    return real(path, ...rest);
  }; };
  for (const [content, pid] of [[JSON.stringify(owner), dead], ['', 0]]) {
    await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000);
    // Round 4 reads owner and age in one step: 1 is the inspected lock, 2 the re-read just before removal.
    replaceBeforeRead(2);
    assert.deepEqual(await unlock(pid), { ...stop('LOCK_OWNER_MISMATCH'), locked: newer }, content);
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), newer);
    // Unchanged, the same inspection removes the lock.
    delete hooks.readFile;
    await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000);
    assert.deepEqual(await unlock(pid), { status: 'unlocked', removed: content ? owner : { unknown: true } }, content);
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  }
  // A dead owner's lock that cannot be deleted is reported, not claimed as removed. Round 4: exactly one unlink
  // attempt (round 3 retried by path, and a retry could remove a lock that a new owner created meanwhile).
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    await writeFile(lock, JSON.stringify(owner));
    let attempts = 0;
    hooks.unlink = (real, path) => { if (resolve(String(path)) === lock) { attempts++; throw fsError(code); } return real(path); };
    assert.deepEqual(await unlock(dead), stop('LOCK_RELEASE_FAILED'), code);
    assert.equal(attempts, 1, `${code}: the removal is attempted once, never retried`);
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), owner);
  }
  delete hooks.unlink;
  assert.deepEqual(await unlock(dead), { status: 'unlocked', removed: owner });
});

test('unlock reports NOT_LOCKED when the lock disappears while it is being inspected', async t => {
  // Round 3 threw (TypeError reading owner.pid of null, or lstat ENOENT) and the CLI printed CLI_INPUT_ERROR.
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t);
  const lock = join(s.sessionDir, '.lock'), dead = deadPid(), WRITTEN = 1700000000000, owner = JSON.stringify({ pid: dead, command: 'decide', sinceEpochMs: 1 });
  const unlock = pid => api.unlockClaudeChromeSession({ sessionDir: s.sessionDir, pid, now: () => WRITTEN + 600000 });
  const outcome = async pid => { try { return await unlock(pid); } catch (error) { return { threw: `${error.name}: ${error.message}` }; } };
  // Removed (by a concurrent unlock, or by its owner finishing) after the first read (before the age is read)
  // or after the re-read just before removal.
  for (const [content, pid, removedAfterRead] of [[owner, dead, 1], [owner, dead, 2], ['', 0, 1], ['', 0, 2]]) {
    await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000);
    let reads = 0;
    hooks.readFile = async (real, path, ...rest) => {
      const value = await real(path, ...rest);
      if (resolve(String(path)) === lock && ++reads === removedAfterRead) await rm(lock, { force: true });
      return value;
    };
    assert.deepEqual(await outcome(pid), stop('NOT_LOCKED'), `${pid} after read ${removedAfterRead}`);
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  }
  delete hooks.readFile;
  // Removed while its age is being read, and removed just before the one unlink attempt: still NOT_LOCKED, not 'unlocked'.
  for (const [name, pid, content] of [['lstat', dead, owner], ['lstat', 0, ''], ['unlink', dead, owner], ['unlink', 0, '']]) {
    await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000);
    hooks[name] = async (real, path, ...rest) => {
      if (resolve(String(path)) === lock) await rm(lock, { force: true });
      return real(path, ...rest);
    };
    assert.deepEqual(await outcome(pid), stop('NOT_LOCKED'), `${name} ${pid}`);
    delete hooks[name];
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  }
  // Without interference the same locks are removed.
  for (const [pid, content] of [[dead, owner], [0, '']]) {
    await writeFile(lock, content); await utimes(lock, WRITTEN / 1000, WRITTEN / 1000);
    assert.deepEqual(await outcome(pid), { status: 'unlocked', removed: content ? JSON.parse(owner) : { unknown: true } });
  }
});

test('the lock appears with its owner record already written, never as an empty file', async t => {
  const s = await session(t);
  const lockPath = join(s.sessionDir, '.lock'), seen = [];
  // A reader polling between every step of 20 commands must never see a lock without an owner.
  for (let round = 0; round < 20; round++) {
    let settled = false;
    const running = s.run('authorize', { raw: checked(page(), 'ref_1') }).finally(() => { settled = true; });
    while (!settled) {
      try { seen.push(readFileSync(lockPath, 'utf8')); } catch (error) { if (!['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; }
      await tick();
    }
    assert.equal((await running).reason, 'NO_PENDING_PROPOSAL');
  }
  assert.ok(seen.length > 0, 'the lock was never observed');
  for (const content of seen) {
    const owner = JSON.parse(content);
    assert.deepEqual([Object.keys(owner).sort(), owner.pid, owner.command, Number.isSafeInteger(owner.sinceEpochMs)],
      [['command', 'pid', 'sinceEpochMs'], process.pid, 'authorize', true], content);
  }
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('the lock is published by linking a complete owner file; without hard links it falls back to an exclusive create', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api, script: [['query', 'e_0']] });
  const lockPath = join(s.sessionDir, '.lock'), ledgerPath = join(s.sessionDir, 'session.json');
  let calls = [], lockWhileLoading = [], linkError;
  const lockFile = path => typeof path === 'string' && basename(path).startsWith('.lock');
  hooks.open = (real, path, ...rest) => { if (lockFile(path)) calls.push(['open', basename(path), rest[0]]); return real(path, ...rest); };
  hooks.link = async (real, from, to) => {
    calls.push(['link', basename(from), basename(to), JSON.parse(await readFile(from, 'utf8'))]);
    if (linkError) throw fsError(linkError);
    return real(from, to);
  };
  hooks.unlink = (real, path) => { if (lockFile(path)) calls.push(['unlink', basename(path)]); return real(path); };
  hooks.readFile = (real, path, ...rest) => { if (resolve(String(path)) === ledgerPath) lockWhileLoading.push(readFileSync(lockPath, 'utf8')); return real(path, ...rest); };
  const check = (command, fallback) => {
    const [[, temporary], [, from, to, owner]] = calls;
    assert.match(temporary, /^\.lock\.[0-9a-f-]{36}\.tmp$/);
    assert.deepEqual([from, to, Object.keys(owner).sort(), owner.pid, owner.command], [temporary, '.lock', ['command', 'pid', 'sinceEpochMs'], process.pid, command]);
    // The lock path itself is only ever created directly when the link failed.
    assert.deepEqual(calls, [['open', temporary, 'wx'], ['link', temporary, '.lock', owner], ...(fallback ? [['open', '.lock', 'wx']] : []),
      ['unlink', temporary], ['unlink', '.lock']], command);
    assert.deepEqual(lockWhileLoading.map(text => JSON.parse(text)), [owner]);
    calls = []; lockWhileLoading = [];
  };
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  check('decide', false);
  // Filesystems without hard links: exclusive create, then the owner is written before the command runs.
  for (const code of ['EPERM', 'ENOTSUP']) {
    linkError = code;
    const refused = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
    assert.equal(refused.reason, 'NO_PENDING_ACTION', code);
    check('verify', true);
  }
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
  check('authorize', true);
  linkError = undefined;
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('SESSION_NOT_FOUND and SESSION_INVALID create nothing and leave no lock', async t => {
  const api = await subject(), dir = await temporary(t), missing = join(dir, 'missing'), empty = join(dir, 'empty');
  await mkdir(empty);
  const options = sessionDir => ({ sessionDir, apiKey: KEY, fetchImpl: () => assert.fail('no request may be sent') });
  for (const command of ['decide', 'authorize', 'verify']) {
    assert.deepEqual(await api.runClaudeChromeSession(command, { raw: page() }, options(missing)), stop('SESSION_NOT_FOUND'), command);
    assert.deepEqual(await api.runClaudeChromeSession(command, { raw: page() }, options(empty)), stop('SESSION_INVALID'), command);
  }
  assert.deepEqual(await api.runClaudeChromeSession('status', {}, options(missing)), stop('SESSION_INVALID'));
  assert.deepEqual([(await readdir(dir)).sort(), await readdir(empty)], [['empty'], []]);
});

test('a lock that cannot be removed is retried, then reported with lockReleaseFailed instead of being swallowed', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api, script: [['query', 'e_0']] });
  const lockPath = join(s.sessionDir, '.lock');
  let refusals;
  const refuse = (times, code) => { let left = times; refusals = 0;
    hooks.unlink = (real, path) => { if (resolve(String(path)) === lockPath && left-- > 0) { refusals++; throw fsError(code); } return real(path); }; };
  // A scanner holding the lock for a moment: the release is retried and succeeds.
  refuse(3, 'EBUSY');
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.status, 'lockReleaseFailed' in proposed, refusals], ['proposed', false, 3]);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  // A lock that can never be removed: the saved result is still returned, flagged, after bounded retries.
  refuse(Infinity, 'EPERM');
  const authorized = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.deepEqual([authorized.status, authorized.lockReleaseFailed, refusals], ['authorized', true, 20]);
  assert.equal((await s.ledger()).pending.stage, 'authorized');
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.deepEqual([owner.pid, owner.command], [process.pid, 'authorize']);
  // An error that retrying cannot fix is reported at once; a refused command is flagged too.
  await rm(lockPath);
  refuse(Infinity, 'EIO');
  const early = await s.run('decide', { raw: page() });
  assert.deepEqual([early.reason, early.lockReleaseFailed, refusals], ['ACTION_UNVERIFIED', true, 1]);
  delete hooks.unlink;
  // The lock that stayed behind blocks every later command and is shown by status. Its owner is this live
  // process, so unlock refuses it too: the flag is how a module host learns why (documented residual).
  const left = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.deepEqual(await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT }), { ...stop('SESSION_BUSY'), locked: left });
  assert.deepEqual((await s.run('status')).session.locked, left);
  assert.deepEqual(await api.unlockClaudeChromeSession({ sessionDir: s.sessionDir, pid: process.pid }), { ...stop('LOCK_OWNER_RUNNING'), locked: left });
  await rm(lockPath);
  const verified = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual([verified.status, verified.inputEvidence, 'lockReleaseFailed' in verified], ['observed_after_action', 'tool_report', false]);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('leftover temp files from interrupted writes never block later writes', async t => {
  const s = await session(t, { script: [['search', 'e_1']] });
  // The round-1 fixed temp name, a current-style name, another process's name, and a round-3 lock owner file
  // left by a process killed before it could link it into place (it is not a lock).
  const leftovers = [`session.json.${process.pid}.tmp`, `session.json.${process.pid}.${randomUUID()}.tmp`, 'session.json.1.tmp',
    `.lock.${randomUUID()}.tmp`];
  for (const name of leftovers) await writeFile(join(s.sessionDir, name), '{"partial":');
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_2') })).status, 'authorized');
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).status, 'observed_after_action');
  const status = await s.run('status');
  assert.deepEqual([status.session.status, status.session.history, status.session.pending, status.session.locked], ['active', [{ actionId: 'search' }], null, null]);
  // Successful writes leave no temp file of their own.
  assert.deepEqual((await readdir(s.sessionDir)).sort(), ['session.json', ...leftovers].sort());
});

test('a ledger write that cannot complete removes its temp file, releases the lock and hands out nothing',
  { skip: process.platform !== 'win32' && 'only Windows refuses to replace a file that another handle has open' }, async t => {
    const s = await session(t, { script: [['query', 'e_0']] });
    await s.run('decide', { raw: page() });
    const before = await s.ledgerText();
    // Held open for longer than every rename retry.
    const reader = await open(join(s.sessionDir, 'session.json'), 'r');
    let outcome;
    try { outcome = await s.run('authorize', { raw: checked(page(), 'ref_1') }); }
    catch (error) { outcome = { threw: `${error.name}: ${error.message}` }; }
    finally { await reader.close(); }
    // An authorization that was never recorded must not reach the host.
    assert.notEqual(outcome?.status, 'authorized');
    assert.equal(outcome?.toolCall, undefined);
    // Round 4: reported as SESSION_IO_ERROR, without internal details, instead of a thrown fs error.
    assert.deepEqual(outcome, stop('SESSION_IO_ERROR'));
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
    assert.equal(await s.ledgerText(), before);
    assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
  });

test('an unexpected ledger write failure inside a command is SESSION_IO_ERROR without details, hands out nothing and releases the lock', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api, script: [['query', 'e_0'], ['query', 'e_0']] });
  const ledgerPath = join(s.sessionDir, 'session.json');
  // Fails the n-th ledger replace from now on (1 = the next one) with an error that no retry fixes.
  const failReplace = (n, code = 'EIO') => { let replaces = 0;
    hooks.rename = (real, from, to) => { if (resolve(String(to)) === ledgerPath && ++replaces === n) throw fsError(code, `simulated ${code} at ${ledgerPath}`); return real(from, to); }; };
  const hidden = result => { const text = JSON.stringify(result); assert.ok(!/EIO|ENOSPC|simulated|session\.json/.test(text) && !text.includes(basename(s.dir)), text); };
  // decide: the count was saved before the request left; the proposal's save fails. The proposal is not handed
  // out, the request stays counted and its cost is unknown, and the session stays usable.
  failReplace(2);
  const lost = await s.run('decide', { raw: page() });
  assert.deepEqual(lost, stop('SESSION_IO_ERROR')); hidden(lost);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  assert.equal(s.mock.bodies.length, 1);
  const counted = await s.ledger();
  assert.deepEqual([counted.status, counted.calls, counted.pending, counted.usage.requests], ['active', 1, null, 0]);
  const status = await s.run('status');
  assert.deepEqual([status.session.status, status.session.calls, status.session.pending, status.session.usage.estimatedJevUsd, status.session.locked], ['active', 1, null, null, null]);
  delete hooks.rename;
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.status, proposed.session.calls, proposed.session.usage.requests, proposed.session.usage.estimatedJevUsd], ['proposed', 2, 1, null]);
  // authorize: an authorization that was never recorded is not handed out; nothing changed, so it can be retried.
  const pending = await s.ledgerText();
  failReplace(1, 'ENOSPC');
  const refused = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.deepEqual(refused, stop('SESSION_IO_ERROR')); hidden(refused);
  assert.equal(await s.ledgerText(), pending);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  delete hooks.rename;
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
  // verify: the result is not recorded, so the action stays authorized (never re-authorized or replayed) and
  // can be verified from a new observation.
  const waiting = await s.ledgerText();
  failReplace(1);
  const unrecorded = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual(unrecorded, stop('SESSION_IO_ERROR')); hidden(unrecorded);
  assert.equal(await s.ledgerText(), waiting);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  delete hooks.rename;
  for (const command of ['decide', 'authorize']) assert.equal((await s.run(command, { raw: checked(page(), 'ref_1') })).reason, 'ACTION_UNVERIFIED', command);
  const verified = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT });
  assert.deepEqual([verified.status, verified.inputEvidence, verified.session.history], ['observed_after_action', 'tool_report', [{ actionId: 'query' }]]);
  assert.equal(s.mock.bodies.length, 2);
});

test('an unexpected ledger read failure inside a command is SESSION_IO_ERROR, not SESSION_INVALID', async t => {
    const hooks = {}, api = await injectedSubject(t, hooks);
    const s = await session(t, { api, script: [['query', 'e_0']] });
    const ledgerPath = join(s.sessionDir, 'session.json'), before = await s.ledgerText();
    for (const code of ['EIO', 'EBUSY']) {
      let armed = true;
      hooks.readFile = (real, path, ...rest) => { if (armed && resolve(String(path)) === ledgerPath) { armed = false; throw fsError(code); } return real(path, ...rest); };
      const result = await s.run('decide', { raw: page() });
      assert.equal(armed, false, 'the ledger read was reached');
      assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
      assert.equal(await s.ledgerText(), before);
      assert.deepEqual(result, stop('SESSION_IO_ERROR'), code);
    }
    delete hooks.readFile;
    assert.equal(s.mock.bodies.length, 0);
    assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  });

test('a lock whose owner record cannot be written by the exclusive-create fallback is removed again', async t => {
  // Round 3 left an empty `.lock` behind, which blocked every later command as an ownerless lock.
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api, script: [['query', 'e_0']] });
  const lockPath = join(s.sessionDir, '.lock'), before = await s.ledgerText();
  hooks.link = () => { throw fsError('ENOTSUP'); };
  hooks.open = async (real, path, ...rest) => {
    const handle = await real(path, ...rest);
    if (resolve(String(path)) !== lockPath) return handle;
    return { writeFile: async () => { throw fsError('ENOSPC'); }, close: () => handle.close() };
  };
  let outcome;
  try { outcome = await s.run('decide', { raw: page() }); } catch (error) { outcome = { threw: error.code }; }
  assert.equal(outcome.status === 'proposed' || outcome.proposal !== undefined, false, JSON.stringify(outcome));
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 0);
  delete hooks.open; delete hooks.link;
  assert.deepEqual((await s.run('status')).session.locked, null);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
});

test('an unexpected I/O error while taking the lock is SESSION_IO_ERROR and leaves neither a lock nor a temp file', async t => {
    const hooks = {}, api = await injectedSubject(t, hooks);
    const s = await session(t, { api, script: [['query', 'e_0']] });
    const lockPath = join(s.sessionDir, '.lock'), before = await s.ledgerText();
    const failingOwnerWrite = match => { hooks.open = async (real, path, ...rest) => {
      const handle = await real(path, ...rest);
      return match(basename(String(path))) ? { writeFile: async () => { throw fsError('ENOSPC', `simulated ENOSPC at ${path}`); }, close: () => handle.close() } : handle;
    }; };
    for (const [label, match, link] of [['temp owner file', name => /^\.lock\..+\.tmp$/.test(name), undefined],
      ['exclusive-create fallback', name => name === '.lock', () => { throw fsError('ENOTSUP'); }]]) {
      failingOwnerWrite(match);
      if (link) hooks.link = link; else delete hooks.link;
      let outcome;
      try { outcome = await s.run('decide', { raw: page() }); } catch (error) { outcome = { threw: `${error.code}: ${error.message}` }; }
      delete hooks.open;
      assert.equal(existsSync(lockPath), false, label);
      assert.equal(await s.ledgerText(), before, label);
      assert.deepEqual(outcome, stop('SESSION_IO_ERROR'), label);
      assert.deepEqual(await readdir(s.sessionDir), ['session.json'], label);
    }
    delete hooks.link;
    assert.equal(s.mock.bodies.length, 0);
    assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  });

test('a request whose count cannot be recorded is never sent and changes nothing (LEDGER_WRITE_FAILED)', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  const s = await session(t, { api, script: [['query', 'e_0']] });
  const before = await s.ledgerText();
  let posted = 0;
  const fetchImpl = (...args) => { posted++; return s.mock.fetchImpl(...args); };
  // A full disk fails at once; a replace that stays refused fails after the bounded retries.
  for (const code of ['ENOSPC', 'EPERM']) {
    hooks.rename = (real, from, to) => { if (basename(String(to)) === 'session.json') throw fsError(code); return real(from, to); };
    const result = await s.run('decide', { raw: page() }, { fetchImpl });
    assert.deepEqual([result.status, result.reason, result.proposal, result.session.status, result.session.calls, result.session.pending, result.session.usage.requests],
      ['needs_host', 'LEDGER_WRITE_FAILED', undefined, 'active', 0, null, 0], code);
    assert.equal(await s.ledgerText(), before);
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  }
  assert.equal(posted, 0);
  delete hooks.rename;
  const proposed = await s.run('decide', { raw: page() }, { fetchImpl });
  assert.deepEqual([proposed.status, proposed.session.calls, proposed.session.usage.requests, posted], ['proposed', 1, 1, 1]);
});

test('a ledger that Windows refuses to replace stops the request before it is sent',
  { skip: process.platform !== 'win32' && 'a read-only file only blocks a replacing rename on Windows (covered with injection above)' }, async t => {
    const s = await session(t, { script: [['query', 'e_0']] });
    const ledgerPath = join(s.sessionDir, 'session.json'), before = await s.ledgerText();
    await chmod(ledgerPath, 0o444);
    let result;
    try { result = await s.run('decide', { raw: page() }); } finally { await chmod(ledgerPath, 0o666); }
    assert.deepEqual([result.reason, result.session.status, result.session.calls], ['LEDGER_WRITE_FAILED', 'active', 0]);
    assert.equal(s.mock.bodies.length, 0);
    assert.equal(await s.ledgerText(), before);
    assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
    assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  });

test('a pre-request count still being written when the decider times out is awaited before anything else is decided', async t => {
  const hooks = {}, api = await injectedSubject(t, hooks);
  // Mirrors fetch: an already aborted request is rejected without being sent.
  const signals = [];
  const fetchImpl = (url, request) => { signals.push(request.signal.aborted); return request.signal.aborted ? Promise.reject(request.signal.reason) : new Promise(() => {}); };
  // The first ledger replace is held past the decider timeout (50 ms) and the command's 2 s usage flush.
  const holdFirstReplace = outcome => { let armed = true;
    hooks.rename = async (real, from, to) => {
      if (!armed || basename(String(to)) !== 'session.json') return real(from, to);
      armed = false; await pause(2500);
      if (outcome === 'fail') throw fsError('EIO');
      return real(from, to);
    }; };
  // It then fails: nothing was sent, the count is rolled back, and the ledger is unchanged.
  const failing = await session(t, { api, input: { api: { timeoutMs: 50 } } });
  const before = await failing.ledgerText();
  holdFirstReplace('fail');
  const lost = await failing.run('decide', { raw: page() }, { fetchImpl });
  assert.deepEqual([lost.reason, lost.session.status, lost.session.calls, lost.session.usage.requests], ['LEDGER_WRITE_FAILED', 'active', 0, 0]);
  assert.deepEqual(signals, []);
  await pause(100);
  assert.equal(await failing.ledgerText(), before);
  assert.deepEqual(await readdir(failing.sessionDir), ['session.json']);
  // It then succeeds: the timeout stops the session, and that stop is written after the late count, never before.
  const late = await session(t, { api, input: { api: { timeoutMs: 50 } } });
  holdFirstReplace('succeed');
  const timedOut = await late.run('decide', { raw: page() }, { fetchImpl });
  assert.deepEqual([timedOut.reason, timedOut.session.status, timedOut.session.calls, timedOut.session.usage.estimatedJevUsd], ['TIMEOUT', 'needs_host', 1, null]);
  // A request released after the decider gave up carries an aborted signal, so fetch never sends it.
  assert.ok(signals.length <= 1 && signals.every(aborted => aborted === true), JSON.stringify(signals));
  await pause(100);
  const ledger = await late.ledger();
  assert.deepEqual([ledger.status, ledger.reason, ledger.calls], ['needs_host', 'TIMEOUT', 1]);
  assert.deepEqual(await readdir(late.sessionDir), ['session.json']);
});

test('a failed verification keeps the authorization as unverified and is never replayed', async t => {
  const s = await session(t, { script: [['search', 'e_1']] });
  await s.run('decide', { raw: page() });
  const authorized = await s.run('authorize', { raw: checked(page(), 'ref_2') });
  const failed = await s.run('verify', { raw: page() });
  assert.deepEqual([failed.reason, failed.session.status, failed.session.pending, failed.session.history], ['NO_OBSERVABLE_PROGRESS', 'needs_host', 'authorized', []]);
  const { pending } = await s.ledger();
  assert.deepEqual([pending.stage, pending.outcome, pending.authorization.toolCall], ['authorized', 'unverified', authorized.toolCall]);
  const stopped = await s.ledgerText();
  for (const command of ['verify', 'authorize', 'decide']) assert.equal((await s.run(command, { raw: page(RESULTS) })).reason, 'SESSION_STOPPED');
  assert.equal(await s.ledgerText(), stopped);
  const typing = await session(t, { script: [['query', 'e_0']] });
  await typing.run('decide', { raw: page() }); await typing.run('authorize', { raw: checked(page(), 'ref_1') });
  assert.equal((await typing.run('verify', { raw: checked(page(), 'ref_1'), toolResult: 'Set search value to "gui" (previous: "")' })).reason, 'INPUT_NOT_VERIFIED');
  assert.deepEqual([(await typing.ledger()).pending.outcome, (await typing.ledger()).inputs], ['unverified', []]);
  // A semantic authorize failure consumes the proposal and stops instead.
  const stale = await session(t, { script: [['query', 'e_0']] });
  await stale.run('decide', { raw: page() });
  const renamedPage = page({ lines: ['textbox "Search all" [ref_1] type="search"', SEARCH[1]] });
  const renamed = await stale.run('authorize', { raw: checked(renamedPage, 'ref_1') });
  assert.deepEqual([renamed.reason, renamed.session.status, renamed.session.pending], ['STALE_TARGET', 'needs_host', null]);
});

test('verify ignores a tool report that is not timed after the authorization and refuses a malformed report time', async t => {
  for (const [time, evidence] of [[at => at, undefined], [at => at - 1000, undefined], [() => 0, undefined], [at => at + 1, 'tool_report']]) {
    const s = await session(t, { script: [['query', 'e_0']] });
    await s.run('decide', { raw: page() });
    const { authorizedAtEpochMs } = await s.run('authorize', { raw: checked(page(), 'ref_1') });
    const toolResultAtEpochMs = time(authorizedAtEpochMs);
    const result = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT, toolResultAtEpochMs });
    const ledger = await s.ledger();
    if (evidence) {
      assert.deepEqual([result.status, result.inputEvidence, ledger.inputs.map(item => item.value)], ['observed_after_action', evidence, ['guide']]);
      continue;
    }
    // A report written before the action cannot describe it: the action stays unverified and is never replayed.
    assert.deepEqual([result.reason, result.session.status, ledger.pending.outcome, ledger.inputs, ledger.history],
      ['INPUT_NOT_VERIFIED', 'needs_host', 'unverified', [], []], JSON.stringify(toolResultAtEpochMs));
  }
  // Round 3: a report time that is not a non-negative safe integer (a raw fractional mtimeMs, a string) is an
  // argument error before anything is judged, so a genuine report is not silently dropped and the session is not stopped.
  const s = await session(t, { script: [['query', 'e_0']] });
  await s.run('decide', { raw: page() });
  const { authorizedAtEpochMs: at } = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  const waiting = await s.ledgerText();
  for (const toolResultAtEpochMs of [at + 0.5, String(at + 1), -1, NaN, Infinity, null, 2 ** 53, true, {}, [at + 1]]) {
    assert.deepEqual(await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT, toolResultAtEpochMs }), stop('INVALID_ARGUMENTS'), String(toolResultAtEpochMs));
  }
  assert.equal(await s.ledgerText(), waiting);
  const verified = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT, toolResultAtEpochMs: at + 1 });
  assert.deepEqual([verified.status, verified.inputEvidence, (await s.ledger()).inputs.map(item => item.value)], ['observed_after_action', 'tool_report', ['guide']]);
});

test('a form_input report copied from a batch keeps its label and still verifies the input', async t => {
  // Round 2: the documented `[form_input] ` batch label made a genuine report unusable and stopped the session.
  // Round 4: the label is accepted with or without its trailing space, and one trailing newline is allowed.
  for (const toolResult of [`[form_input] ${REPORT}`, `[form_input]${REPORT}`, `[form_input] ${REPORT}\n`]) {
    const s = await session(t, { script: [['query', 'e_0']] });
    await s.run('decide', { raw: page() });
    assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_1') })).status, 'authorized');
    const verified = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult });
    assert.deepEqual([verified.status, verified.inputEvidence, (await s.ledger()).inputs.map(item => item.value)], ['observed_after_action', 'tool_report', ['guide']], JSON.stringify(toolResult));
  }
  // Only that one label: any other prefix is not the tool's report.
  const other = await session(t, { script: [['query', 'e_0']] });
  await other.run('decide', { raw: page() });
  await other.run('authorize', { raw: checked(page(), 'ref_1') });
  const refused = await other.run('verify', { raw: checked(page(), 'ref_1'), toolResult: `[get_page_text] ${REPORT}` });
  assert.deepEqual([refused.reason, refused.session.status, (await other.ledger()).pending.outcome], ['INPUT_NOT_VERIFIED', 'needs_host', 'unverified']);
});

test('a tool-reported input is shown to JEV again only for the same field on the same URL', async t => {
  const s = await session(t);
  await typed(s);
  const decideOn = async raw => { s.mock.script.push(['search', 'e_1']); assert.equal((await s.run('decide', { raw })).status, 'proposed'); return sent(s)[0]; };
  const shown = await decideOn(page());
  assert.deepEqual([shown.value, shown.valueSource], ['guide', 'tool_report']);
  for (const variant of [
    page({ url: 'https://example.com/?q=guide' }),
    page({ lines: ['textbox "Search" [ref_5] type="search"', SEARCH[1]] }),
    page({ lines: ['textbox "Search guides" [ref_1] type="search"', SEARCH[1]] }),
    page({ lines: ['textbox "Search" [ref_1] type="text"', SEARCH[1]] }),
    page({ lines: ['searchbox "Search" [ref_1] type="search"', SEARCH[1]] }),
  ]) assert.equal((await decideOn(variant)).value, undefined, `${variant.readPage} ${variant.pageText}`);
  assert.equal((await decideOn(page())).value, 'guide');
  // Round 2 also records the page text the value belongs to (as a hash).
  const [{ textHash, ...remembered }, ...more] = (await s.ledger()).inputs;
  assert.deepEqual([remembered, more], [{ ref: 'ref_1', url: 'https://example.com/', role: 'textbox', name: 'Search', description: 'type=search', value: 'guide' }, []]);
  assert.match(textHash, HASH);
});

test('a remembered value is not shown again once the page text has changed', async t => {
  const s = await session(t);
  await typed(s);
  const decideOn = async raw => { s.mock.script.push(['search', 'e_1']); assert.equal((await s.run('decide', { raw })).status, 'proposed'); return sent(s)[0]; };
  // read_page never shows a labelled field's value, so a page that reset the field looks identical apart from its text.
  for (const text of ['Search the guides\nThe search box was cleared', 'Search the guide', 'Search the guides ', '']) {
    assert.equal((await decideOn(page({ text }))).value, undefined, JSON.stringify(text));
  }
  assert.equal((await decideOn(page())).value, 'guide');
  assert.equal((await s.ledger()).inputs.length, 1);
});

test('a remembered value reaches JEV marked as a tool report in the observation and in every target option', async t => {
  const s = await session(t);
  await typed(s);
  s.mock.script.push(['search', 'e_1']);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  const body = s.mock.bodies.at(-1), [field] = body.state.observation.elements;
  assert.deepEqual(field, { ref: 0, role: 'textbox', name: 'Search', description: 'type=search', value: 'guide', valueSource: 'tool_report', editable: true });
  for (const id of ['query', 'requery']) assert.deepEqual(JSON.parse(body.questions[`target_${id}`].criteria.e_0), field, id);
  // A value the host observed on the page itself carries no source.
  const e = await session(t, { script: [['search', 'e_1']] });
  const observation = envelope(e.clock.now + 1000);
  observation.elements[0] = { ...observation.elements[0], value: 'guide' };
  assert.equal((await e.run('decide', { observation })).status, 'proposed');
  assert.deepEqual(e.mock.bodies[0].state.observation.elements[0], { ref: 0, role: 'textbox', name: 'Search', description: 'type=search', value: 'guide', editable: true });
});

test('a remembered value withheld by the page-text gate between decide and authorize does not make the target stale', async t => {
  const s = await session(t);
  await typed(s);
  // Live suggestions after typing change the page text, so the remembered value is not attached to that read.
  const suggesting = page({ text: 'Search the guides\nSuggestions: guide, guides' });
  s.mock.script.push(['requery', 'e_0']);
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.proposal.target.value, proposed.proposal.target.valueSource], ['guide', 'tool_report']);
  // Round 2 compared the remembered value as part of the target and stopped here with STALE_TARGET.
  const retyping = await s.run('authorize', { raw: checked(suggesting, 'ref_1') });
  assert.deepEqual([retyping.status, retyping.toolCall?.arguments, retyping.session.status], ['authorized', { tabId: 12, ref: 'ref_1', value: 'guides' }, 'active']);
  const verified = await s.run('verify', { raw: checked(suggesting, 'ref_1'), toolResult: 'Set search value to "guides" (previous: "guide")' });
  assert.deepEqual([verified.status, verified.inputEvidence], ['observed_after_action', 'tool_report']);
  // The text still gates what JEV is shown: remembered with the suggestions, so not shown on the plain page.
  s.mock.script.push(['search', 'e_1']);
  assert.equal((await s.run('decide', { raw: page() })).proposal.actionId, 'search');
  assert.equal(sent(s)[0].value, undefined);
  // The other way round (withheld at decide, attached at authorize) the field is not a volatile element either.
  const clicking = await s.run('authorize', { raw: checked(suggesting, 'ref_2') });
  assert.deepEqual([clicking.status, clicking.beforeProgress.volatileRefs], ['authorized', []]);
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).status, 'observed_after_action');
  assert.deepEqual((await s.ledger()).history, [{ actionId: 'query' }, { actionId: 'requery' }, { actionId: 'search' }]);
});

test('a click that never reached the page is not verified by a remembered value coming or going with the page text', async t => {
  // Round 2: a rotating notice detached the remembered value at verify, and the unchanged listing counted as progress.
  const A = 'Search the guides\nNotice 1/2: Library opens at 9', B = 'Search the guides\nNotice 2/2: Cafe closed Monday';
  for (const [decideText, authorizeText, verifyText] of [[A, A, B], [A, B, A], [B, A, B], [B, B, A]]) {
    const label = [decideText, authorizeText, verifyText].map(text => (text === A ? 'A' : 'B')).join('');
    const s = await session(t);
    await typed(s, page({ text: A }));
    s.mock.script.push(['search', 'e_1']);
    assert.equal((await s.run('decide', { raw: page({ text: decideText }) })).proposal.actionId, 'search', label);
    assert.equal(sent(s)[0].value, decideText === A ? 'guide' : undefined, label);
    const authorized = await s.run('authorize', { raw: checked(page({ text: authorizeText }), 'ref_2') });
    assert.deepEqual([authorized.status, authorized.beforeProgress.volatileRefs], ['authorized', []], label);
    // Byte-identical listing: the click was dropped (live fact 4); only the notice text moved on.
    const dropped = await s.run('verify', { raw: page({ text: verifyText }) });
    assert.deepEqual([dropped.reason, dropped.session.status, dropped.session.history], ['NO_OBSERVABLE_PROGRESS', 'needs_host', [{ actionId: 'query' }]], label);
    const { pending, inputs } = await s.ledger();
    assert.deepEqual([pending.outcome, inputs.length], ['unverified', 1], label);
  }
  // A click that did change the listing is still verified, and it clears the remembered value.
  const s = await session(t);
  await typed(s, page({ text: A }));
  s.mock.script.push(['search', 'e_1']);
  await s.run('decide', { raw: page({ text: A }) });
  await s.run('authorize', { raw: checked(page({ text: A }), 'ref_2') });
  assert.equal((await s.run('verify', { raw: page({ text: B, lines: RESULTS.lines }) })).status, 'observed_after_action');
  assert.deepEqual((await s.ledger()).inputs, []);
});

test('retyping a value-named field the session already filled is verified from its new name, not blocked by the remembered value', async t => {
  const actions = [
    { id: 'bio', action: 'typeText', description: 'Write the bio', text: 'Night  owl', target: { roles: ['textbox'] } },
    { id: 'rename', action: 'typeText', description: 'Replace the bio', text: 'Morning lark', target: { roles: ['textbox'] } },
    { id: 'reset', action: 'typeText', description: 'Restore the bio', text: 'Early  bird', target: { roles: ['textbox'] } },
    { id: 'save', action: 'click', description: 'Save the bio', target: { roles: ['button'], nameEquals: 'Save' } }];
  // read_page names a label-wrapped field by its trimmed, whitespace-collapsed value.
  const named = name => page({ lines: [`textbox "${name}" [ref_1] type="text"`, 'button "Save" [ref_2]'] });
  const filled = async (actionId, verifyAfter) => {
    const s = await session(t, { input: { plan: plan({ actions, completion: { textIncludes: 'Saved' } }) }, script: [['bio', 'e_0'], [actionId, 'e_0']] });
    await s.run('decide', { raw: named('Early bird') });
    await s.run('authorize', { raw: checked(named('Early bird'), 'ref_1') });
    assert.equal((await s.run('verify', { raw: checked(named('Night owl'), 'ref_1'), toolResult: 'Set text value to "Night  owl" (previous: "Early bird")' })).inputEvidence, 'tool_report');
    const { proposal } = await s.run('decide', { raw: named('Night owl') });
    assert.deepEqual([proposal.actionId, proposal.target.name, proposal.target.value, proposal.target.valueSource], [actionId, 'Night owl', 'Night  owl', 'tool_report']);
    assert.equal((await s.run('authorize', { raw: checked(named('Night owl'), 'ref_1') })).status, 'authorized');
    return { s, verified: await s.run('verify', verifyAfter) };
  };
  // Round 2 treated the remembered value as a value the page showed before, and refused both renames.
  const renamed = await filled('rename', { raw: checked(named('Morning lark'), 'ref_1') });
  assert.deepEqual([renamed.verified.status, renamed.verified.inputEvidence], ['observed_after_action', 'observed_name']);
  assert.deepEqual([(await renamed.s.ledger()).history, (await renamed.s.ledger()).inputs], [[{ actionId: 'bio' }, { actionId: 'rename' }], []]);
  const reset = await filled('reset', { raw: checked(named('Early bird'), 'ref_1'), toolResult: 'Set text value to "Early  bird" (previous: "Night  owl")' });
  assert.deepEqual([reset.verified.status, reset.verified.inputEvidence], ['observed_after_action', 'tool_report']);
  const [{ textHash, ...remembered }] = (await reset.s.ledger()).inputs;
  assert.deepEqual(remembered, { ref: 'ref_1', url: 'https://example.com/', role: 'textbox', name: 'Early bird', description: 'type=text', value: 'Early  bird' });
  // The remembered value is never evidence: an unchanged field with no report is not verified.
  const unchanged = await filled('rename', { raw: checked(named('Night owl'), 'ref_1') });
  assert.deepEqual([unchanged.verified.reason, unchanged.verified.session.status], ['INPUT_NOT_VERIFIED', 'needs_host']);
  assert.deepEqual([(await unchanged.s.ledger()).pending.outcome, (await unchanged.s.ledger()).history], ['unverified', [{ actionId: 'bio' }]]);
  assert.equal((await unchanged.s.run('decide', { raw: named('Night owl') })).reason, 'SESSION_STOPPED');
});

test('a remembered 6–8 digit or date value in a labelled field no longer wedges later commands', async t => {
  // Round 3: the remembered host text was re-attached as the field's value and the bridge refused any text field
  // whose value was secret-shaped (or, before that, date- or postal-shaped), so every later decide, authorize and
  // verify on that page returned INVALID_OBSERVATION. Round 4 checks a value only when the page itself showed it.
  // Each case: the host text, the labelled field as read_page lists it, and the form_input report for it.
  const cases = [
    ['482913', 'textbox "Booking number" [ref_1] type="text"', 'Set text value to "482913" (previous: "")'],
    ['48291357', 'textbox "Booking number" [ref_1] type="text"', 'Set text value to "48291357" (previous: "")'],
    ['482 913', 'textbox "Booking number" [ref_1] type="text"', 'Set text value to "482 913" (previous: "")'],
    ['4829135', 'textbox "Booking number" [ref_1] type="number"', 'Set number input to 4829135 (previous: )'],
    ['2026-10-01', 'textbox "Booking number" [ref_1] type="date"', 'Set date to "2026-10-01" (previous: )'],
    ['123-4567', 'textbox "Booking number" [ref_1] type="text"', '[form_input]Set text value to "123-4567" (previous: "")\n'],
  ];
  for (const [text, field, report] of cases) {
    const actions = [{ id: 'fill', action: 'typeText', description: 'Fill the booking number', text, target: { roles: ['textbox'], nameEquals: 'Booking number' } },
      { id: 'find', action: 'click', description: 'Find the booking after the number is entered', target: { roles: ['button'], nameEquals: 'Find' } }];
    const form = page({ lines: [field, 'button "Find" [ref_2]'] });
    const found = page({ text: 'Results for your booking', lines: [field, 'button "Find" [ref_2]', 'link "Booking details" [ref_3] href="/booking"'] });
    const s = await session(t, { input: { plan: plan({ actions, completion: { textIncludes: 'Results' } }) }, script: [['fill', 'e_0'], ['find', 'e_1']] });
    assert.equal((await s.run('decide', { raw: form })).status, 'proposed', text);
    assert.equal((await s.run('authorize', { raw: checked(form, 'ref_1') })).status, 'authorized', text);
    const verified = await s.run('verify', { raw: checked(form, 'ref_1'), toolResult: report });
    assert.deepEqual([verified.status, verified.inputEvidence], ['observed_after_action', 'tool_report'], text);
    assert.deepEqual((await s.ledger()).inputs.map(item => item.value), [text], text);
    // The host's own plan text is already part of every request; it is not page data to withhold.
    const next = await s.run('decide', { raw: form });
    assert.deepEqual([next.status, next.proposal?.actionId, next.session.status], ['proposed', 'find', 'active'], `${text}: ${next.reason}`);
    assert.deepEqual([sent(s)[0].value, sent(s)[0].valueSource], [text, 'tool_report'], text);
    const clicking = await s.run('authorize', { raw: checked(form, 'ref_2') });
    assert.deepEqual([clicking.status, clicking.toolCall?.arguments.ref], ['authorized', 'ref_2'], `${text}: ${clicking.reason}`);
    const clicked = await s.run('verify', { raw: found });
    assert.deepEqual([clicked.status, clicked.completionMatches, clicked.session.history], ['observed_after_action', true, [{ actionId: 'fill' }, { actionId: 'find' }]], `${text}: ${clicked.reason}`);
    assert.deepEqual((await s.ledger()).inputs, [], text);
  }
  // Protection is unchanged for what the page itself shows: a secret-shaped value observed on the page (no
  // tool-report source) is still refused, and nothing is sent or changed.
  const s = await session(t, { script: [['query', 'e_0']] });
  const before = await s.ledgerText();
  for (const value of ['482913', '482 913', '48291357', '4111 1111 1111 1111']) {
    const observation = envelope(s.clock.now + 1000);
    observation.elements[0] = { ...observation.elements[0], value };
    const result = await s.run('decide', { observation });
    assert.deepEqual([result.reason, result.session.status, result.session.calls], ['INVALID_OBSERVATION', 'active', 0], value);
  }
  assert.equal(await s.ledgerText(), before);
  assert.equal(s.mock.bodies.length, 0);
});

test('a value-named field is remembered under the name read_page gives it after typing', async t => {
  const bio = { id: 'bio', action: 'typeText', description: 'Replace the bio', text: 'Night  owl', target: { roles: ['textbox'] } };
  const save = { id: 'save', action: 'click', description: 'Save the bio', target: { roles: ['button'], nameEquals: 'Save' } };
  const s = await session(t, { input: { plan: plan({ actions: [bio, save], completion: { textIncludes: 'Saved' } }) }, script: [['bio', 'e_0'], ['save', 'e_1'], ['save', 'e_1']] });
  // A label-wrapped field is named by its trimmed, whitespace-collapsed value.
  const before = page({ lines: ['textbox "Early bird" [ref_1] type="text"', 'button "Save" [ref_2]'] });
  const after = page({ lines: ['textbox "Night owl" [ref_1] type="text"', 'button "Save" [ref_2]'] });
  assert.equal((await s.run('decide', { raw: before })).proposal.target.name, 'Early bird');
  assert.equal((await s.run('authorize', { raw: checked(before, 'ref_1') })).status, 'authorized');
  const verified = await s.run('verify', { raw: checked(after, 'ref_1'), toolResult: 'Set text value to "Night  owl" (previous: "Early bird")' });
  assert.deepEqual([verified.status, verified.inputEvidence], ['observed_after_action', 'tool_report']);
  const [{ textHash, ...remembered }] = (await s.ledger()).inputs;
  assert.deepEqual(remembered, { ref: 'ref_1', url: 'https://example.com/', role: 'textbox', name: 'Night owl', description: 'type=text', value: 'Night  owl' });
  assert.match(textHash, HASH);
  await s.run('decide', { raw: after });
  assert.equal(sent(s)[0].value, 'Night  owl');
  await s.run('decide', { raw: before });
  assert.equal(sent(s)[0].value, undefined);
});

test('malformed observations after a remembered input are refused as INVALID_OBSERVATION without changing anything', async t => {
  const s = await session(t);
  await typed(s);
  // Built just before each call so that only the malformed part can fail.
  const malformed = () => [undefined, null, {}, 'x', 7, [], { elements: {} }, { ...envelope(s.clock.now), elements: {} },
    { ...envelope(s.clock.now), elements: [null] }, { ...envelope(s.clock.now), text: 7 }, { ...envelope(s.clock.now), tab: null }];
  const refused = async command => {
    const before = await s.ledgerText();
    for (const observation of malformed()) {
      const result = await s.run(command, { observation });
      assert.deepEqual([result.status, result.reason, result.session?.status], ['needs_host', 'INVALID_OBSERVATION', 'active'], `${command} ${JSON.stringify(observation)}`);
    }
    assert.equal(await s.ledgerText(), before);
  };
  await refused('decide');
  assert.equal(s.mock.bodies.length, 1);
  s.mock.script.push(['search', 'e_1']);
  assert.equal((await s.run('decide', { raw: page() })).status, 'proposed');
  await refused('authorize');
  assert.equal((await s.run('authorize', { raw: checked(page(), 'ref_2') })).status, 'authorized');
  await refused('verify');
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).status, 'observed_after_action');
});

test('remembered inputs are cleared by a verified click', async t => {
  const s = await session(t);
  await typed(s);
  s.mock.script.push(['search', 'e_1'], ['search', 'e_1']);
  await s.run('decide', { raw: page() });
  assert.equal(sent(s)[0].value, 'guide');
  await s.run('authorize', { raw: checked(page(), 'ref_2') });
  assert.equal((await s.run('verify', { raw: page(RESULTS) })).status, 'observed_after_action');
  assert.deepEqual((await s.ledger()).inputs, []);
  await s.run('decide', { raw: page(RESULTS) });
  assert.equal(sent(s)[0].value, undefined);
});

test('the field being verified is judged from fresh evidence, not from its remembered value', async t => {
  const s = await session(t);
  await typed(s);
  s.mock.script.push(['requery', 'e_0'], ['search', 'e_1']);
  const proposed = await s.run('decide', { raw: page() });
  assert.deepEqual([proposed.proposal.actionId, proposed.proposal.target.value], ['requery', 'guide']);
  assert.deepEqual((await s.run('authorize', { raw: checked(page(), 'ref_1') })).toolCall.arguments, { tabId: 12, ref: 'ref_1', value: 'guides' });
  const verified = await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: 'Set search value to "guides" (previous: "guide")' });
  assert.deepEqual([verified.status, verified.inputEvidence], ['observed_after_action', 'tool_report']);
  await s.run('decide', { raw: page() });
  assert.equal(sent(s)[0].value, 'guides');
  assert.deepEqual((await s.ledger()).inputs.map(item => item.value), ['guides']);
});

test('a value marked as a tool report in a host envelope is never observed-value evidence for the field being verified', async t => {
  // Round 4: observed_value needs a value the page showed. A host that copies the session's remembered value
  // into its own envelope cannot verify a form_input that may never have happened.
  const s = await session(t, { script: [['query', 'e_0']] });
  await s.run('decide', { raw: page() });
  const { authorizedAtEpochMs } = await s.run('authorize', { raw: checked(page(), 'ref_1') });
  const observation = envelope(authorizedAtEpochMs + 500);
  observation.elements[0] = { ...observation.elements[0], value: 'guide', valueSource: 'tool_report' };
  const refused = await s.run('verify', { observation });
  assert.deepEqual([refused.reason, refused.inputEvidence, refused.session.status, refused.session.pending, refused.session.history],
    ['INPUT_NOT_VERIFIED', undefined, 'needs_host', 'authorized', []]);
  assert.deepEqual([(await s.ledger()).pending.outcome, (await s.ledger()).inputs], ['unverified', []]);
  // The same value shown by the page itself is evidence.
  const e = await session(t, { script: [['query', 'e_0']] });
  await e.run('decide', { raw: page() });
  const authorized = await e.run('authorize', { raw: checked(page(), 'ref_1') });
  const shown = envelope(authorized.authorizedAtEpochMs + 500);
  shown.elements[0] = { ...shown.elements[0], value: 'guide' };
  const verified = await e.run('verify', { observation: shown });
  assert.deepEqual([verified.status, verified.inputEvidence], ['observed_after_action', 'observed_value']);
  // Only tool_report evidence is remembered; a value the page shows needs no memory.
  assert.deepEqual((await e.ledger()).inputs, []);
});

test('status is read-only and neither results nor ledger files ever contain the API key', async t => {
  const s = await session(t, { script: [['query', 'e_0']] });
  const outputs = [s.started, await s.run('decide', { raw: page() }), await s.run('authorize', { raw: checked(page(), 'ref_1') }),
    await s.run('verify', { raw: checked(page(), 'ref_1'), toolResult: REPORT })];
  const before = await s.ledgerText();
  const status = await s.run('status');
  assert.deepEqual(Object.keys(status), ['status', 'session']);
  assert.deepEqual([status.session.remainingMs, status.session.calls, status.session.history, status.session.locked], [61000 - s.clock.now, 1, [{ actionId: 'query' }], null]);
  // Status needs no key, lock or observation and ignores any input.
  const bare = await s.api.runClaudeChromeSession('status', { raw: 'ignored' }, { sessionDir: s.sessionDir, fetchImpl: () => assert.fail('status must not request') });
  outputs.push(status, bare);
  assert.equal(await s.ledgerText(), before);
  assert.deepEqual(await readdir(s.sessionDir), ['session.json']);
  for (const output of outputs) assert.ok(!JSON.stringify(output).includes(KEY));
  for (const name of await readdir(s.sessionDir)) assert.ok(!(await readFile(join(s.sessionDir, name), 'utf8')).includes(KEY));
});

// CLI: separate node processes, the way Claude Code invokes the bridge.
const cliEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'TYPESAFE_API_KEY'));
function cli(args, input = '') {
  const result = spawnSync(process.execPath, ['--', 'src/claude-chrome-cli.mjs', ...args], { cwd: ROOT, input, encoding: 'utf8', env: cliEnv(), timeout: 30000 });
  return { code: result.status, output: JSON.parse(result.stdout) };
}
function cliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--', 'src/claude-chrome-cli.mjs', ...args], { cwd: ROOT, env: cliEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, pid: child.pid, output: JSON.parse(stdout) }); } catch (error) { reject(error); } });
  });
}
// One file per official tool result. Every authorize and verify needs newly written files.
async function writeRaw(directory, raw, toolResult) {
  for (const [file, text] of [['tabs-context.txt', raw.tabsContext], ['read-page.txt', raw.readPage], ['page-text.txt', raw.pageText],
    ['ref-check.txt', raw.refCheck], ['tool-result.txt', toolResult]]) if (text !== undefined) await writeFile(join(directory, file), text);
  return directory;
}
async function rawDirectory(parent, name, raw, toolResult) {
  const directory = join(parent, name); await mkdir(directory);
  return writeRaw(directory, raw, toolResult);
}
const rawArgs = (sessionDir, directory) => ['--session', sessionDir, '--raw', directory, '--tab-id', '12'];

test('CLI observe normalizes one raw directory without a session, key or tool-result file', async t => {
  const dir = await temporary(t), raw = page({ lines: [...SEARCH, 'textbox "[value redacted]" [ref_6] type="password"', ' option "One"'] });
  const directory = await rawDirectory(dir, 'raw', { ...raw, readPage: `﻿${raw.readPage.replace(/\n/g, '\r\n')}` }, OVERSIZED);
  const { code, output } = cli(['observe', '--raw', directory, '--tab-id', '12']);
  assert.deepEqual([code, output.status, output.observation.text], [0, 'observed', 'Search the guides']);
  assert.deepEqual(output.observation.tab, { id: 12, url: 'https://example.com/', title: 'Guides' });
  assert.deepEqual(output.observation.elements.map(element => element.ref), ['ref_1', 'ref_2']);
  assert.deepEqual(output.omitted, { protected: 1, withoutRef: 1 });
});

test('CLI start and status share one exclusive ledger', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), input = join(dir, 'start.json');
  await writeFile(input, JSON.stringify({ plan: plan(), maxCalls: 4 }));
  const started = cli(['start', '--session', sessionDir, '--input', input]);
  assert.deepEqual([started.code, started.output.status, started.output.session.maxCalls], [0, 'started', 4]);
  const status = cli(['status', '--session', sessionDir]);
  assert.deepEqual([status.code, status.output.status, status.output.session.status, status.output.session.calls, status.output.session.locked], [0, 'session', 'active', 0, null]);
  assert.deepEqual(cli(['start', '--session', sessionDir], JSON.stringify({ plan: plan() })), { code: 2, output: stop('SESSION_EXISTS') });
  assert.deepEqual(cli(['status', '--session', join(dir, 'missing')]), { code: 2, output: stop('SESSION_INVALID') });
});

test('CLI authorize and verify drive a module-created proposal from fresh raw directories; only verify reads tool-result.txt', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), api = await subject(), mock = jev([['query', 'e_0'], ['search', 'e_1']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  const decide = () => api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl });
  const ledger = () => readFile(join(sessionDir, 'session.json'), 'utf8');
  assert.equal((await decide()).status, 'proposed');
  await settle();
  // authorize reads ref-check.txt and never tool-result.txt.
  const typing = await rawDirectory(dir, 'typing', checked(page(), 'ref_1'), OVERSIZED);
  const authorized = cli(['authorize', ...rawArgs(sessionDir, typing)]);
  assert.deepEqual([authorized.code, authorized.output.status], [0, 'authorized']);
  assert.deepEqual(authorized.output.toolCall, { tool: 'form_input', arguments: { tabId: 12, ref: 'ref_1', value: 'guide' } });
  const waiting = await ledger();
  await settle();
  assert.deepEqual(cli(['verify', ...rawArgs(sessionDir, await rawDirectory(dir, 'oversized', checked(page(), 'ref_1'), OVERSIZED))]), { code: 2, output: stop('INPUT_TOO_LARGE') });
  const unchecked = cli(['verify', ...rawArgs(sessionDir, await rawDirectory(dir, 'unchecked', page(), `${REPORT}\r\n`))]);
  assert.deepEqual([unchecked.code, unchecked.output.reason, unchecked.output.session.pending], [2, 'REF_CHECK_REQUIRED', 'authorized']);
  assert.equal(await ledger(), waiting);
  const verified = cli(['verify', ...rawArgs(sessionDir, await rawDirectory(dir, 'typed', checked(page(), 'ref_1'), `${REPORT}\r\n`))]);
  assert.deepEqual([verified.code, verified.output.status, verified.output.inputEvidence], [0, 'observed_after_action', 'tool_report']);
  assert.equal((await decide()).proposal.actionId, 'search');
  assert.equal(mock.bodies[1].state.observation.elements[0].value, 'guide');
  await settle();
  assert.equal(cli(['authorize', ...rawArgs(sessionDir, await rawDirectory(dir, 'clicking', checked(page(), 'ref_2')))]).output.toolCall.tool, 'computer');
  await settle();
  const clicked = cli(['verify', ...rawArgs(sessionDir, await rawDirectory(dir, 'after', page(RESULTS)))]);
  assert.deepEqual([clicked.code, clicked.output.status, clicked.output.inputEvidence], [0, 'observed_after_action', undefined]);
  const { session: status } = cli(['status', '--session', sessionDir]).output;
  assert.deepEqual([status.status, status.calls, status.pending, status.history], ['active', 2, null, [{ actionId: 'query' }, { actionId: 'search' }]]);
  assert.ok(!(await ledger()).includes(KEY));
});

test('CLI raw directories are dated by their oldest file, so a reused directory is never fresh', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), api = await subject(), mock = jev([['query', 'e_0']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  const ledger = () => readFile(join(sessionDir, 'session.json'), 'utf8');
  const early = await rawDirectory(dir, 'early', checked(page(), 'ref_1'));
  await settle();
  assert.equal((await api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl })).status, 'proposed');
  const proposed = await ledger();
  const outcome = result => [result.code, result.output.reason, result.output.session?.status, result.output.session?.pending];
  // Written before the proposal existed.
  assert.deepEqual(outcome(cli(['authorize', ...rawArgs(sessionDir, early)])), [2, 'FRESH_OBSERVATION_REQUIRED', 'active', 'proposed']);
  // Rewriting some of the files is not enough.
  await settle();
  const fresh = checked(page(), 'ref_1');
  for (const [file, text] of [['read-page.txt', fresh.readPage], ['page-text.txt', fresh.pageText], ['ref-check.txt', fresh.refCheck]]) await writeFile(join(early, file), text);
  assert.deepEqual(outcome(cli(['authorize', ...rawArgs(sessionDir, early)])), [2, 'FRESH_OBSERVATION_REQUIRED', 'active', 'proposed']);
  assert.equal(await ledger(), proposed);
  await writeFile(join(early, 'tabs-context.txt'), fresh.tabsContext);
  assert.equal(cli(['authorize', ...rawArgs(sessionDir, early)]).output.status, 'authorized');
  const waiting = await ledger();
  // The directory that authorized the action cannot also verify it, even with a new report beside it.
  await settle();
  await writeFile(join(early, 'tool-result.txt'), REPORT);
  assert.deepEqual(outcome(cli(['verify', ...rawArgs(sessionDir, early)])), [2, 'FRESH_OBSERVATION_REQUIRED', 'active', 'authorized']);
  assert.equal(await ledger(), waiting);
  const verified = cli(['verify', ...rawArgs(sessionDir, await rawDirectory(dir, 'after', fresh, REPORT))]);
  assert.deepEqual([verified.code, verified.output.inputEvidence], [0, 'tool_report']);
});

test('CLI dates a raw directory by ref-check.txt too, so a ref check left from an earlier read is never fresh', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), api = await subject(), mock = jev([['query', 'e_0']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  const ledger = () => readFile(join(sessionDir, 'session.json'), 'utf8');
  const outcome = result => [result.code, result.output.reason, result.output.session?.status, result.output.session?.pending];
  const backdate = (file, epochMs) => utimes(file, epochMs / 1000, epochMs / 1000);
  const { proposal } = await api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl });
  const proposed = await ledger();
  await settle();
  const fresh = checked(page(), 'ref_1');
  // Every listing file is new; only the ref check predates the proposal.
  const typing = await rawDirectory(dir, 'typing', fresh);
  await backdate(join(typing, 'ref-check.txt'), proposal.createdAtEpochMs - 1000);
  assert.deepEqual(outcome(cli(['authorize', ...rawArgs(sessionDir, typing)])), [2, 'FRESH_OBSERVATION_REQUIRED', 'active', 'proposed']);
  assert.equal(await ledger(), proposed);
  await writeFile(join(typing, 'ref-check.txt'), fresh.refCheck);
  const authorized = cli(['authorize', ...rawArgs(sessionDir, typing)]);
  assert.deepEqual([authorized.code, authorized.output.status], [0, 'authorized']);
  const waiting = await ledger();
  await settle();
  // New listing and report, but the ref check predates the authorization.
  const typedDir = await rawDirectory(dir, 'typed', fresh, REPORT);
  await backdate(join(typedDir, 'ref-check.txt'), authorized.output.authorizedAtEpochMs - 1000);
  assert.deepEqual(outcome(cli(['verify', ...rawArgs(sessionDir, typedDir)])), [2, 'FRESH_OBSERVATION_REQUIRED', 'active', 'authorized']);
  assert.equal(await ledger(), waiting);
  await writeFile(join(typedDir, 'ref-check.txt'), fresh.refCheck);
  const verified = cli(['verify', ...rawArgs(sessionDir, typedDir)]);
  assert.deepEqual([verified.code, verified.output.status, verified.output.inputEvidence], [0, 'observed_after_action', 'tool_report']);
  // decide reads no ref check: an old one beside fresh listings is ignored, an old listing is not.
  // The CLI environment carries no key, so decide stops before any request with MISSING_API_KEY.
  const deciding = await rawDirectory(dir, 'deciding', fresh);
  await backdate(join(deciding, 'ref-check.txt'), Date.now() - 300000);
  const noKey = cli(['decide', ...rawArgs(sessionDir, deciding)]);
  assert.deepEqual([noKey.code, noKey.output.reason, noKey.output.session.status, noKey.output.session.calls], [2, 'MISSING_API_KEY', 'active', 1]);
  await backdate(join(deciding, 'tabs-context.txt'), Date.now() - 300000);
  const stale = cli(['decide', ...rawArgs(sessionDir, deciding)]);
  assert.deepEqual([stale.code, stale.output.reason, stale.output.session.status, stale.output.session.calls], [2, 'INVALID_OBSERVATION', 'active', 1]);
  assert.equal(mock.bodies.length, 1);
});

test('CLI verify ignores a tool-result.txt written before the authorization, so a leftover report proves nothing', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), api = await subject(), mock = jev([['query', 'e_0']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  assert.equal((await api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl })).status, 'proposed');
  await settle();
  // The host reuses a directory that still holds the report of an earlier, identical form_input.
  const reused = await rawDirectory(dir, 'reused', checked(page(), 'ref_1'), REPORT);
  assert.equal(cli(['authorize', ...rawArgs(sessionDir, reused)]).output.status, 'authorized');
  await settle();
  const { tabsContext, readPage, pageText, refCheck } = checked(page(), 'ref_1');
  await writeRaw(reused, { tabsContext, readPage, pageText, refCheck });
  const verified = cli(['verify', ...rawArgs(sessionDir, reused)]);
  assert.deepEqual([verified.code, verified.output.reason, verified.output.inputEvidence, verified.output.session.status, verified.output.session.pending],
    [2, 'INPUT_NOT_VERIFIED', undefined, 'needs_host', 'authorized']);
  const { pending, inputs, history } = JSON.parse(await readFile(join(sessionDir, 'session.json'), 'utf8'));
  assert.deepEqual([pending.outcome, inputs, history], ['unverified', [], []]);
});

test('CLI concurrent authorize processes authorize one proposal at most once', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session'), api = await subject(), mock = jev([['query', 'e_0']]);
  assert.equal((await api.startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  assert.equal((await api.runClaudeChromeSession('decide', { raw: page() }, { sessionDir, apiKey: KEY, fetchImpl: mock.fetchImpl })).status, 'proposed');
  await settle();
  const raw = await rawDirectory(dir, 'raw', checked(page(), 'ref_1'));
  // A reader holding the ledger open slows each write on Windows, so the processes overlap.
  const reader = await open(join(sessionDir, 'session.json'), 'r');
  const release = pause(300).then(() => reader.close());
  const results = await Promise.all([1, 2, 3].map(() => cliAsync(['authorize', ...rawArgs(sessionDir, raw)])));
  await release;
  const winners = results.filter(result => result.output.status === 'authorized');
  assert.equal(winners.length, 1, JSON.stringify(results.map(result => result.output.reason ?? result.output.status)));
  const pids = results.map(result => result.pid);
  for (const loser of results.filter(result => result !== winners[0])) {
    assert.equal(loser.code, 2);
    assert.ok(['SESSION_BUSY', 'ACTION_UNVERIFIED'].includes(loser.output.reason), JSON.stringify(loser.output));
    if (loser.output.locked?.pid !== undefined) assert.ok(pids.includes(loser.output.locked.pid) && loser.output.locked.pid !== loser.pid);
  }
  const { pending } = JSON.parse(await readFile(join(sessionDir, 'session.json'), 'utf8'));
  assert.deepEqual([pending.stage, pending.authorization.authorizedAtEpochMs], ['authorized', winners[0].output.authorizedAtEpochMs]);
  assert.deepEqual(await readdir(sessionDir), ['session.json']);
});

test('CLI argument errors exit 2 with INVALID_ARGUMENTS before reading input, the ledger or the network', async t => {
  const dir = await temporary(t), sessionDir = join(dir, 'session');
  assert.equal((await (await subject()).startClaudeChromeSession({ plan: plan() }, { sessionDir })).status, 'started');
  const raw = await rawDirectory(dir, 'raw', page()), env = join(dir, 'jev.env'), ledger = await readFile(join(sessionDir, 'session.json'), 'utf8');
  await writeFile(env, `TYPESAFE_API_KEY=${KEY}\n`);
  for (const args of [
    ['observe', '--raw', raw],
    ['verify', '--session', sessionDir, '--tab-id', '12'],
    ['decide', '--raw', raw, '--tab-id', '12', '--env-file', env],
    ['authorize', '--session', sessionDir, '--raw', raw, '--tab-id', '12', '--env-file', env],
    ['verify', '--session', sessionDir, '--env-file', env, '--raw', raw, '--tab-id', '12'],
    ['observe', '--raw', raw, '--tab-id', 'twelve'],
    ['verify', '--session', sessionDir, '--raw', raw, '--tab-id', '012'],
    ['observe', '--session', sessionDir, '--raw', raw, '--tab-id', '12'],
    ['start', '--session', join(dir, 'other'), '--raw', raw, '--tab-id', '12'],
    ['status', '--session', sessionDir, '--input', env],
    ['decide', '--session', sessionDir, '--raw', raw, '--tab-id', '12', '--input', env],
    ['verify', '--session', sessionDir, '--raw', raw, '--tab-id', '12', '--pid', '4242'],
    ['unlock', '--session', sessionDir],
    ['unlock', '--pid', '4242'],
    // `--pid 0` is valid since round 3 (ownerless-lock recovery); other non-canonical pids are not.
    ['unlock', '--session', sessionDir, '--pid', '00'],
    ['unlock', '--session', sessionDir, '--pid', '-1'],
    ['unlock', '--session', sessionDir, '--pid', '04242'],
    ['unlock', '--session', sessionDir, '--pid', 'self'],
    ['unlock', '--session', sessionDir, '--pid', '4242', '--raw', raw],
    ['unlock', '--session', sessionDir, '--pid', '4242', '--pid', '4243'],
    ['launch', '--session', sessionDir],
  ]) assert.deepEqual(cli(args), { code: 2, output: stop('INVALID_ARGUMENTS') }, args.join(' '));
  assert.equal(await readFile(join(sessionDir, 'session.json'), 'utf8'), ledger);
  assert.deepEqual(await readdir(sessionDir), ['session.json']);
  assert.deepEqual((await readdir(dir)).sort(), ['jev.env', 'raw', 'session']);
});
