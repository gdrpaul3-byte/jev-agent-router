import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const subject = () => import('../benchmarks/task-router-eval.mjs');
const sample = (id, expected = { routeId: 'draft', requiresHostApproval: false }) => ({
  id, label: '합성 예제', expected,
  input: { task: { id, revision: 1, request: 'PRIVATE_SYNTHETIC_TEXT', progress: 'Ready' }, routes: [
    { id: 'research', description: 'Research missing sources', kind: 'read' },
    { id: 'draft', description: 'Draft from evidence', kind: 'draft' },
  ], baselineRouteId: 'research' },
});
const cost = (calls = 1, tokens = 100) => ({ calls, inputTokens: tokens, knownInputTokens: tokens ?? 0,
  estimatedJevUsd: tokens === null ? null : tokens * 0.042 / 1000000, knownUsageUsd: (tokens ?? 0) * 0.042 / 1000000,
  complete: tokens !== null, cashChargeUsd: null, hostCostUsd: null });
const selected = (routeId = 'draft', extra = {}) => ({ status: 'shadow', recommendationId: routeId, effectiveRouteId: 'research', requiresHostApproval: false, recommendationRequiresHostApproval: false,
  confidence: 0.97, margin: 0.94, model: 'jev-1.13.0', latencyMs: 10, replayed: false, cost: cost(),
  requests: [{ index: 1, inputTokens: 100, outputTokens: 0, latencyMs: 5, usageLatencyMs: 8, model: 'jev-1.13.0', error: null }], ...extra });
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'jev-router-eval-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('bundled Korean synthetic workload is bounded, labeled, diverse and valid', async () => {
  const fixture = JSON.parse(await readFile(new URL('../benchmarks/task-router-cases.json', import.meta.url), 'utf8'));
  assert.ok(fixture.cases.length >= 16 && fixture.cases.length <= 20);
  assert.equal(fixture.synthetic, true);
  const report = await (await subject()).evaluateRouterCases(fixture.cases, { stateDir: 'unused', apiKey: 'fake', runRoutingTask: async () => selected() });
  assert.equal(report.cases.length, fixture.cases.length);
  assert.ok(fixture.cases.filter(item => item.expected.needsHost).length >= 3);
  assert.ok(fixture.cases.some(item => item.expected.requiresHostApproval));
  assert.ok(fixture.cases.some(item => item.input.routes.some(route => route.available === false)));
  assert.ok(new Set(fixture.cases.flatMap(item => item.input.routes.map(route => route.id))).size >= 10);
});

test('accepted accuracy, routing coverage and expected-host correctness remain separate', async () => {
  const cases = [sample('correct'), sample('wrong'), sample('abstain'), sample('host', { needsHost: true }), sample('error', { needsHost: true })];
  const runner = async input => input.task.id === 'correct' ? selected()
    : input.task.id === 'wrong' ? selected('research')
    : input.task.id === 'error' ? { status: 'needs_host', reason: 'HTTP_ERROR', latencyMs: 3, cost: cost(1, null), requests: [] }
    : { status: 'needs_host', reason: 'NO_SAFE_ROUTE', latencyMs: 3, cost: cost(), requests: [] };
  const report = await (await subject()).evaluateRouterCases(cases, { stateDir: 'unused', apiKey: 'fake', runRoutingTask: runner });
  assert.deepEqual(report.metrics.routing, { expected: 3, accepted: 2, correct: 1, coverage: 2 / 3, acceptedAccuracy: 0.5 });
  assert.deepEqual(report.metrics.expectedHost, { expected: 2, correctAbstentions: 1, correctness: 0.5 });
  assert.equal(report.metrics.outcomes.accepted, 2); assert.equal(report.metrics.outcomes.abstained, 2); assert.equal(report.metrics.outcomes.errors, 1);
  assert.equal(report.metrics.cost.estimatedJevUsd, null);
  assert.equal(report.metrics.cost.knownUsageUsd, 4 * cost().estimatedJevUsd);
  assert.equal(report.metrics.cost.unknownCases, 1);
  assert.equal(report.cases.find(item => item.id === 'error').correct, false);
});

test('unexpected acceptance of an expected-host case is a false acceptance, not accurate routing', async () => {
  const report = await (await subject()).evaluateRouterCases([sample('host', { needsHost: true })], { stateDir: 'unused', runRoutingTask: async () => selected() });
  assert.equal(report.metrics.expectedHost.correctness, 0); assert.equal(report.metrics.falseAcceptances, 1);
  assert.equal(report.metrics.routing.acceptedAccuracy, null); assert.equal(report.metrics.routing.coverage, null);
});

test('provider and wall latency and original decision billing are separated on replay', async () => {
  const report = await (await subject()).evaluateRouterCases([sample('replay')], { stateDir: 'unused', runRoutingTask: async () => selected('draft', {
    replayed: true, cost: cost(0, 0), requests: [], decisionCost: cost(), decisionRequests: selected().requests,
  }) });
  const row = report.cases[0]; assert.equal(row.result.cost.estimatedJevUsd, 0); assert.equal(row.result.decisionCost.estimatedJevUsd, cost().estimatedJevUsd);
  assert.ok(row.wallLatencyMs >= 0); assert.equal(row.providerLatencyMs, null);
  assert.equal(report.metrics.cost.calls, 0); assert.equal(report.metrics.replayed, 1);
  assert.equal(report.metrics.providerLatencyMs.samples, 0);
});

test('every case is sequentially recorded after isolated runner errors with no diagnostic leakage', async () => {
  let busy = false, calls = 0; const completed = [];
  const report = await (await subject()).evaluateRouterCases([sample('one'), sample('two')], {
    stateDir: 'unused', maxCalls: 2, apiKey: 'PRIVATE_KEY',
    onProgress: async report => { completed.push(report.cases.length); },
    runRoutingTask: async (_input, options) => { assert.equal(busy, false); busy = true; assert.equal(options.config.mode, 'shadow'); assert.equal(options.config.maxCalls, 2);
      await new Promise(resolve => setImmediate(resolve)); busy = false; calls++;
      if (calls === 1) throw new Error('PRIVATE_KEY PRIVATE_SYNTHETIC_TEXT');
      return selected('draft', { secret: 'PRIVATE_KEY', handoffPath: 'PRIVATE_PATH', reason: 'PRIVATE_KEY', cost: { ...cost(), secret: 'PRIVATE_KEY' } });
    },
  });
  assert.equal(report.cases.length, 2); assert.deepEqual(completed, [1, 2]); assert.equal(report.cases[0].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_KEY|PRIVATE_SYNTHETIC_TEXT|PRIVATE_PATH/);
});

test('workload schema, duplicate IDs, unsafe expectations and case bounds stop before runner', async () => {
  const evaluate = (await subject()).evaluateRouterCases;
  for (const cases of [[], Array(101).fill(sample('same')), [sample('same'), sample('same')], [{ ...sample('one'), expected: { routeId: 'missing' } }], [{ ...sample('one'), extra: 'private' }]]) {
    await assert.rejects(evaluate(cases, { stateDir: 'unused', runRoutingTask: async () => assert.fail('must not run') }), /INVALID_EVALUATION_CASES/);
  }
});

test('CLI is explicitly opt-in and rejects unknown, duplicate, missing and unsafe flags', async t => {
  const dir = await directory(t); const output = join(dir, 'out.json'); const base = ['--live', '--state-dir', join(dir, 'state'), '--output', output];
  for (const argv of [[], ['--state-dir', 'state', '--output', output], [...base, '--live'], [...base, '--wat', 'value'], [...base, '--max-calls', '0'], [...base, '--max-calls', '101'], [...base, '--limit', '1.5'], [...base, '--mode', 'dry-run'], [...base, '--output', 'other'], ['--live', '--output', output]]) {
    const result = await (await subject()).runRouterEvaluationCli(argv, { env: {}, runRoutingTask: async () => assert.fail('must not run') });
    assert.equal(result.exitCode, 2); assert.equal(result.result.status, 'needs_host');
  }
});

test('CLI refuses absent credentials and existing output before a paid call', async t => {
  const dir = await directory(t); const output = join(dir, 'out.json'); const argv = ['--live', '--state-dir', join(dir, 'state'), '--output', output];
  const run = (await subject()).runRouterEvaluationCli;
  assert.equal((await run(argv, { env: {}, runRoutingTask: async () => assert.fail('must not run') })).result.reason, 'MISSING_API_KEY');
  await writeFile(output, 'preserved');
  const result = await run(argv, { env: { TYPESAFE_API_KEY: 'fake' }, runRoutingTask: async () => assert.fail('must not run') });
  assert.equal(result.result.reason, 'OUTPUT_EXISTS'); assert.equal(await readFile(output, 'utf8'), 'preserved');
});

test('CLI bounded live run passes explicit env file, saves only safe metrics, and never echoes paths', async t => {
  const dir = await directory(t); const output = join(dir, 'PRIVATE_PATH.json'); let calls = 0;
  const result = await (await subject()).runRouterEvaluationCli(['--live', '--state-dir', join(dir, 'state'), '--output', output, '--env-file', 'private.env', '--limit', '2', '--max-calls', '2'], {
    env: {}, runRoutingTask: async (_input, options) => { calls++; assert.equal(options.envFile, 'private.env'); assert.equal(options.config.mode, 'shadow'); return selected(); },
  });
  assert.equal(calls, 2); assert.equal(result.exitCode, 0); assert.equal(result.result.status, 'complete');
  const saved = JSON.parse(await readFile(output, 'utf8')); assert.equal(saved.status, 'complete'); assert.equal(saved.cases.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|private.env/);
  assert.equal(Object.hasOwn(saved.cases[0], 'input'), false);
});

test('CLI rejects oversized and invalid custom case files without output creation', async t => {
  const dir = await directory(t); const casesPath = join(dir, 'cases.json'); const output = join(dir, 'out.json');
  const argv = ['--live', '--state-dir', join(dir, 'state'), '--output', output, '--cases', casesPath];
  const run = (await subject()).runRouterEvaluationCli;
  await writeFile(casesPath, ' '.repeat(1000001));
  assert.equal((await run(argv, { env: { TYPESAFE_API_KEY: 'fake' } })).result.reason, 'INPUT_TOO_LARGE');
  await writeFile(casesPath, 'INVALID PRIVATE_KEY');
  const result = await run(argv, { env: { TYPESAFE_API_KEY: 'fake' } });
  assert.equal(result.result.reason, 'INVALID_EVALUATION_CASES'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY/);
});

test('approval-needed routing is scored on recommendation and approval boundary', async () => {
  const one = sample('write', { routeId: 'publish', requiresHostApproval: true });
  one.input.routes = [{ id: 'publish', description: 'Publish approved text', kind: 'write' }]; one.input.baselineRouteId = 'publish';
  const report = await (await subject()).evaluateRouterCases([one], { stateDir: 'unused', mode: 'active', runRoutingTask: async () => selected('publish', { status: 'review_required', requiresHostApproval: true, recommendationRequiresHostApproval: true }) });
  assert.equal(report.cases[0].correct, true); assert.equal(report.cases[0].outcome, 'accepted');
});

test('shadow recommendation approval is independent from effective baseline approval', async () => {
  const one = sample('publish-shadow', { routeId: 'publish', requiresHostApproval: true });
  one.input.routes.push({ id: 'publish', description: 'Publish approved text', kind: 'write' });
  const report = await (await subject()).evaluateRouterCases([one], { stateDir: 'unused', runRoutingTask: async () => selected('publish', {
    effectiveRouteId: 'research', requiresHostApproval: false, recommendationRequiresHostApproval: true,
  }) });
  assert.equal(report.cases[0].correct, true);
  assert.equal(report.cases[0].result.requiresHostApproval, false);
  assert.equal(report.cases[0].result.recommendationRequiresHostApproval, true);
});

test('state IO and capacity failures retain only their fixed diagnostic reason', async () => {
  for (const reason of ['STATE_IO_ERROR', 'STATE_CAPACITY_EXCEEDED']) {
    const report = await (await subject()).evaluateRouterCases([sample('state-error')], { stateDir: 'unused', runRoutingTask: async () => ({ status: 'needs_host', reason }) });
    assert.equal(report.cases[0].result.reason, reason);
    assert.equal(report.cases[0].outcome, 'error');
  }
});
