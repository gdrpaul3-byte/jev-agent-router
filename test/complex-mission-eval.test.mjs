import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const load = async () => { try { return await import('../benchmarks/complex-mission-eval.mjs'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; } };
const cases = () => ['base', 'changed'].map(variant => ({ id: 'm1', variant,
  mission: { instructions: 'Synthesize supplied evidence.', context: 'Stable policy', input: { request: 'Plan', revision: variant === 'base' ? 1 : 2 }, schema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false } },
  routingInputs: [{ task: { id: 't0', revision: 1, request: 'Retrieve', progress: variant, evidence: [] }, routes: [{ id: 'doc', description: 'A document', kind: 'read', available: true, requiresApproval: false }], baselineRouteId: 'doc' }],
  toolOutputs: { doc: { id: 'b1', text: variant === 'base' ? 'first evidence' : 'changed evidence' } },
  expected: { output: { answer: variant === 'base' ? 1 : 2 }, routing: [{ routeId: 'doc', requiresHostApproval: false }] }
}));
function deps(overrides = {}) {
  return {
    prepareAdaptiveRoute: () => ({ status: 'preflight' }),
    prepareStructuredRequest: () => ({ status: 'prepared', requestBytes: 100 }),
    runAdaptiveRoute: async () => ({ status: 'selected', routeId: 'doc', requiresHostApproval: false, requests: 0, attempts: [], cacheHit: false }),
    runStructuredRequest: async request => ({ status: 'ok', value: { answer: request.input.revision }, requests: 0, usage: {}, cost: {} }),
    scoreMission: (value, expected) => ({ passed: value?.answer === expected.output.answer, checksPassed: value?.answer === expected.output.answer ? 1 : 0, checksTotal: 1, failures: value?.answer === expected.output.answer ? [] : ['answer'] }),
    ...overrides,
  };
}

test('balanced schedule grants every arm base, changed evidence, and exact repeat', async () => {
  const { createMissionSchedule } = await load(); assert.equal(typeof createMissionSchedule, 'function');
  const schedule = createMissionSchedule(cases());
  assert.equal(schedule.length, 9);
  for (const arm of ['astra', 'luna', 'adaptive']) assert.deepEqual(schedule.filter(row => row.arm === arm).map(row => row.phase), ['base', 'changed', 'exact_repeat']);
  assert.deepEqual(schedule.slice(0, 3).map(row => row.arm), ['astra', 'luna', 'adaptive']);
  assert.deepEqual(schedule.slice(3, 6).map(row => row.arm), ['luna', 'adaptive', 'astra']);
});

test('entire workflow cache is exact and shared fairly; labels never enter either runner', async () => {
  const { evaluateComplexMissions } = await load();
  const dir = await mkdtemp(join(tmpdir(), 'jev-complex-'));
  let routingCalls = 0, synthesisCalls = 0;
  try {
    const report = await evaluateComplexMissions(cases(), { stateDir: dir, dependencies: deps({
      runAdaptiveRoute: async input => { routingCalls++; assert.equal(JSON.stringify(input).includes('expected'), false); return { status: 'selected', routeId: 'doc', requiresHostApproval: false, cacheHit: false, attempts: [] }; },
      runStructuredRequest: async request => { synthesisCalls++; assert.equal(JSON.stringify(request).includes('expected'), false); assert.equal(request.input.evidence.length, 1); return { status: 'ok', value: { answer: request.input.revision }, usage: {}, cost: {} }; },
    }) });
    assert.equal(routingCalls, 6); assert.equal(synthesisCalls, 6);
    assert.equal(report.runs.length, 9);
    assert.equal(report.runs.filter(row => row.cacheHit).length, 3);
    assert.ok(report.runs.every(row => row.quality.passed));
    assert.ok(report.runs.filter(row => row.phase === 'changed').every(row => !row.cacheHit));
    assert.ok(report.runs.filter(row => row.phase === 'exact_repeat').every(row => row.requests === 0));
    assert.equal(report.accounting.requests, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('route failure does not synthesize, pass as abstention, or enter result cache', async () => {
  const { evaluateComplexMissions } = await load();
  const dir = await mkdtemp(join(tmpdir(), 'jev-complex-'));
  let calls = 0;
  try {
    const report = await evaluateComplexMissions(cases(), { stateDir: dir, dependencies: deps({
      runAdaptiveRoute: async () => ({ status: 'needs_host', reason: 'TIMEOUT', attempts: [] }),
      runStructuredRequest: async () => { calls++; return { status: 'ok', value: { answer: 1 } }; },
    }) });
    assert.equal(calls, 0);
    assert.equal(report.runs.length, 9);
    assert.ok(report.runs.every(row => row.status === 'routing_failed' && !row.cacheHit && !row.quality.passed));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incorrect but structurally valid output is scored honestly including cache replay', async () => {
  const { evaluateComplexMissions } = await load();
  const dir = await mkdtemp(join(tmpdir(), 'jev-complex-'));
  try {
    const report = await evaluateComplexMissions(cases(), { stateDir: dir, dependencies: deps({ runStructuredRequest: async () => ({ status: 'ok', value: { answer: 999 }, usage: {}, cost: {} }) }) });
    assert.ok(report.runs.every(row => !row.quality.passed));
    assert.equal(report.runs.filter(row => row.cacheHit).length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsupported schedule and absent output path are rejected before model dispatch', async () => {
  const { createMissionSchedule, runComplexMissionCli } = await load();
  assert.throws(() => createMissionSchedule([cases()[0]]), /INVALID_MISSION_CASES/);
  assert.equal((await runComplexMissionCli(['--live'])).exitCode, 2);
});

test('cost report uses all actual POSTs including synthesis; failed unknown charge halts run', async () => {
  const { evaluateComplexMissions } = await load();
  const dir = await mkdtemp(join(tmpdir(), 'jev-complex-'));
  let network = 0;
  try {
    const report = await evaluateComplexMissions(cases(), { stateDir: dir, fetchImpl: async () => { network++; return new Response(JSON.stringify({ error: { message: 'private-key' } }), { status: 500 }); }, dependencies: deps({
      runAdaptiveRoute: async (_input, options) => {
        await options.fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{"model":"openai/gpt-6-luna","max_tokens":512}', signal: new AbortController().signal });
        return { status: 'needs_host', reason: 'HTTP_ERROR', attempts: [] };
      },
    }) });
    assert.equal(network, 1); assert.equal(report.status, 'stopped');
    assert.equal(report.accounting.accountedProviderUsd, null);
    assert.equal(JSON.stringify(report).includes('private-key'), false);
    assert.equal(report.runs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
