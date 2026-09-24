import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRoutingTask } from '../src/router-task.mjs';

const input = (revision = 1) => ({
  task: { id: 'briefing', revision, request: 'Draft a briefing', progress: 'Research completed', evidence: [{ id: 's1', text: 'Public evidence' }] },
  routes: [
    { id: 'research', description: 'Find missing sources', kind: 'read' },
    { id: 'draft', description: 'Draft using sufficient sources', kind: 'draft' },
    { id: 'send', description: 'Send finished briefing externally', kind: 'write' },
  ], baselineRouteId: 'research',
});
const answer = (route = 'draft', usage = { input_tokens: 100, output_tokens: 0 }) => async (_url, init) => {
  const criteria = JSON.parse(init.body).questions.route.criteria;
  const ids = Object.keys(criteria);
  return Response.json({ model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: route,
    confidence: 0.97, probabilities: Object.fromEntries(ids.map(id => [id, id === route ? 0.97 : 0.03 / (ids.length - 1)])) } }, ...(usage === null ? {} : { usage }) });
};
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-router-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { stateDir: join(root, 'state'), apiKey: 'test-secret-not-real', config: { mode: 'active' }, fetchImpl: answer() };
}
const ledger = async options => JSON.parse(await readFile(join(options.stateDir, 'state.json'), 'utf8'));

test('active decision creates a committed local handoff; replay preserves original cost without another API call', async t => {
  const options = await setup(t); let calls = 0;
  options.fetchImpl = async (...args) => { calls++; return answer()(...args); };
  const first = await runRoutingTask(input(), options);
  assert.equal(first.status, 'ready'); assert.equal(first.effectiveRouteId, 'draft');
  assert.equal(first.requests.length, 1); assert.equal(first.cost.inputTokens, 100);
  assert.ok(Math.abs(first.cost.estimatedJevUsd - 0.0000042) < 1e-15);
  const handoff = JSON.parse(await readFile(first.handoffPath, 'utf8'));
  assert.equal(handoff.executionStatus, 'not_started'); assert.equal(handoff.requiresFreshHostValidation, true);
  const stored = await ledger(options);
  assert.equal(stored.jobs[handoff.stateRecordKey].state, 'completed');
  assert.equal(stored.jobs[handoff.stateRecordKey].fingerprint, handoff.fingerprint);
  const replay = await runRoutingTask(input(), { ...options, apiKey: '' });
  assert.equal(calls, 1); assert.equal(replay.replayed, true);
  assert.equal(replay.handoffPath, first.handoffPath);
  assert.equal(replay.cost.estimatedJevUsd, 0); assert.deepEqual(replay.requests, []);
  assert.deepEqual(replay.decisionCost, first.cost); assert.deepEqual(replay.decisionRequests, first.requests);
});

test('shadow keeps baseline and never creates an execution handoff', async t => {
  const options = await setup(t); options.config.mode = 'shadow';
  const result = await runRoutingTask(input(), options);
  assert.equal(result.status, 'shadow'); assert.equal(result.recommendationId, 'draft');
  assert.equal(result.effectiveRouteId, 'research'); assert.equal(result.handoffPath, undefined);
  assert.equal(result.requiresHostApproval, false);
});

test('write and explicitly approval-required draft routes return review_required without handoff', async t => {
  const options = await setup(t); options.fetchImpl = answer('send');
  const write = await runRoutingTask(input(), options);
  assert.equal(write.status, 'review_required'); assert.equal(write.requiresHostApproval, true);
  assert.equal(write.handoffPath, undefined);
  const changed = input(2); changed.routes[1].requiresApproval = true; options.fetchImpl = answer();
  const draft = await runRoutingTask(changed, options);
  assert.equal(draft.status, 'review_required'); assert.equal(draft.handoffPath, undefined);
});

test('changed evidence or availability requires a new revision; different modes have separate decisions', async t => {
  const options = await setup(t); await runRoutingTask(input(), options);
  const changed = input(); changed.task.evidence[0].text = 'New evidence';
  assert.equal((await runRoutingTask(changed, options)).reason, 'TASK_REVISION_CONFLICT');
  const changedRoute = input(); changedRoute.routes[2].available = false;
  assert.equal((await runRoutingTask(changedRoute, options)).reason, 'TASK_REVISION_CONFLICT');
  assert.equal((await runRoutingTask(input(2), options)).status, 'ready');
  assert.equal((await runRoutingTask(input(), { ...options, config: { mode: 'shadow' } })).status, 'shadow');
  assert.equal((await ledger(options)).attemptedCalls, 3);
});

test('concurrent callers do not both dispatch', async t => {
  const options = await setup(t); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  options.fetchImpl = async (...args) => { entered(); await blocked; return answer()(...args); };
  const first = runRoutingTask(input(), options); await started;
  const second = await runRoutingTask(input(2), options);
  assert.equal(second.reason, 'STATE_BUSY'); release();
  assert.equal((await first).status, 'ready');
  assert.equal((await ledger(options)).attemptedCalls, 1);
});

test('missing credentials and bad env do not reserve or permanently poison the task', async t => {
  const options = await setup(t);
  assert.equal((await runRoutingTask(input(), { ...options, apiKey: '' })).reason, 'MISSING_API_KEY');
  const badEnv = await runRoutingTask(input(), { ...options, apiKey: '', envFile: join(options.stateDir, 'missing.env') });
  assert.equal(badEnv.reason, 'JEV_CONFIG_READ_ERROR');
  await assert.rejects(access(join(options.stateDir, 'state.json')));
  const success = await runRoutingTask(input(), options);
  assert.equal(success.status, 'ready'); assert.equal(success.budget.attemptedCalls, 1);
});

test('network failures count against persistent budget, retain unknown billing and replay without retry', async t => {
  const options = await setup(t); options.config.maxCalls = 1;
  options.fetchImpl = async () => { throw new Error('PRIVATE_PROVIDER_EXCEPTION'); };
  const failed = await runRoutingTask(input(), options);
  assert.equal(failed.status, 'needs_host'); assert.equal(failed.cost.estimatedJevUsd, null);
  assert.equal(failed.budget.attemptedCalls, 1);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_EXCEPTION|test-secret/);
  const replay = await runRoutingTask(input(), options);
  assert.equal(replay.replayed, true); assert.equal(replay.decisionCost.estimatedJevUsd, null);
  assert.equal(replay.cost.estimatedJevUsd, 0);
  assert.equal((await runRoutingTask(input(2), options)).reason, 'CALL_BUDGET_EXHAUSTED');
});

test('pending crash reservation is never retried or reported as a completed decision', async t => {
  const options = await setup(t); await runRoutingTask(input(), options);
  const state = await ledger(options); const job = Object.values(state.jobs)[0];
  job.state = 'pending'; delete job.result; delete job.handoff;
  await writeFile(join(options.stateDir, 'state.json'), JSON.stringify(state));
  options.fetchImpl = async () => { assert.fail('must not retry unknown outcome'); };
  const result = await runRoutingTask(input(), options);
  assert.equal(result.reason, 'TASK_OUTCOME_UNKNOWN'); assert.equal(result.decisionCost.estimatedJevUsd, null);
  assert.equal(result.budget.attemptedCalls, 1);
});

test('missing handoff is recovered from committed state without an API call; mismatched file fails closed', async t => {
  const options = await setup(t); const first = await runRoutingTask(input(), options);
  await rm(first.handoffPath);
  // A crashed publication may leave a temp file, but it is never accepted as an executable handoff.
  await writeFile(`${first.handoffPath}.interrupted.tmp`, '{"partial":');
  options.fetchImpl = async () => { assert.fail('must replay committed decision'); };
  const replay = await runRoutingTask(input(), options);
  assert.equal(replay.status, 'ready'); await access(replay.handoffPath);
  await writeFile(replay.handoffPath, '{"tampered":true}');
  assert.equal((await runRoutingTask(input(), options)).reason, 'HANDOFF_MISMATCH');
});

test('handoff write failure retains the paid committed decision and can be repaired without rebilling', async t => {
  const options = await setup(t); await mkdir(options.stateDir, { recursive: true });
  await writeFile(join(options.stateDir, 'handoffs'), 'obstruction');
  const failed = await runRoutingTask(input(), options);
  assert.equal(failed.reason, 'HANDOFF_WRITE_FAILED'); assert.equal(failed.cost.inputTokens, 100);
  assert.equal(Object.values((await ledger(options)).jobs)[0].state, 'completed');
  await rm(join(options.stateDir, 'handoffs'));
  options.fetchImpl = async () => { assert.fail('must not repeat committed API call'); };
  const replay = await runRoutingTask(input(), options);
  assert.equal(replay.status, 'ready'); assert.equal(replay.replayed, true);
});

test('invalid input, dry-run and disabled need no key or state', async t => {
  const options = await setup(t); const unreachable = async () => { assert.fail('no network'); };
  const dry = await runRoutingTask(input(), { config: { mode: 'dry-run' }, fetchImpl: unreachable });
  assert.equal(dry.status, 'dry_run'); assert.equal(dry.cost.calls, 0);
  const disabled = await runRoutingTask(input(), { config: { enabled: false }, fetchImpl: unreachable });
  assert.equal(disabled.status, 'bypassed'); assert.equal(disabled.effectiveRouteId, 'research');
  assert.equal((await runRoutingTask({ private: 'PRIVATE_TEXT' }, options)).reason, 'INVALID_INPUT');
  await assert.rejects(access(options.stateDir));
  assert.equal((await runRoutingTask(input(), { apiKey: options.apiKey })).reason, 'STATE_DIR_REQUIRED');
});

test('corrupt counters and completed records fail closed, never execute saved arbitrary paths', async t => {
  const options = await setup(t); await runRoutingTask(input(), options);
  const original = await ledger(options);
  for (const alter of [
    s => { s.attemptedCalls = -1; },
    s => { s.attemptedCalls = 0; },
    s => { Object.values(s.jobs)[0].mode = 'dangerous'; },
    s => { Object.values(s.jobs)[0].fingerprint = 'wrong'; },
    s => { Object.values(s.jobs)[0].result.status = 'invented'; },
    s => { Object.values(s.jobs)[0].result.cost.inputTokens = -1; },
    s => { const r = Object.values(s.jobs)[0].result; r.requests[0].inputTokens = 999; r.decisionRequests[0].inputTokens = 999; },
    s => { Object.values(s.jobs)[0].result.handoffPath = '../../outside'; },
  ]) {
    const state = structuredClone(original); alter(state);
    await writeFile(join(options.stateDir, 'state.json'), JSON.stringify(state));
    const result = await runRoutingTask(input(), options);
    assert.equal(result.reason, 'STATE_INVALID');
  }
});

test('a stale lock is not automatically removed', async t => {
  const options = await setup(t); await mkdir(options.stateDir, { recursive: true });
  await writeFile(join(options.stateDir, '.lock'), 'old lock');
  assert.equal((await runRoutingTask(input(), options)).reason, 'STATE_BUSY');
  assert.equal(await readFile(join(options.stateDir, '.lock'), 'utf8'), 'old lock');
});
