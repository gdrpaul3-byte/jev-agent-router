import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareComparisonCases, prepareJevControlRequest, runJevControl } from '../benchmarks/llm-control-cases.mjs';

const fixture = JSON.parse(await readFile(new URL('../benchmarks/news-triage-cases.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function answer(item, selected = item.routes[0].id) {
  const ids = [...item.routes.map(route => route.id), 'NONE'];
  return { type: 'choice', choice: selected, confidence: 0.99,
    probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 0.99 : 0.01 / (ids.length - 1)])) };
}

test('projection excludes evaluator metadata and uses opaque task/evidence identity', () => {
  const cases = clone(fixture.cases.slice(0, 2));
  cases[0].id = 'PrivateCaseMarker'; cases[0].label = 'PrivateLabelMarker';
  cases[0].input.task.id = 'PrivateTaskMarker'; cases[0].input.task.revision = 875;
  cases[0].input.task.evidence[0].id = 'PrivateEvidenceMarker';
  cases[0].input.baselineRouteId = 'skip';
  const result = prepareComparisonCases(cases), wire = JSON.stringify(result.packet);
  for (const marker of ['PrivateCaseMarker', 'PrivateLabelMarker', 'PrivateTaskMarker', 'PrivateEvidenceMarker', 'baselineRouteId', 'expected']) assert.ok(!wire.includes(marker));
  assert.equal(result.packet.tasks[0].id, 't0'); assert.equal(result.packet.tasks[0].task.revision, 1);
  assert.equal(result.packet.tasks[0].task.evidence[0].id, 'e0');
  assert.equal(result.inputs[0].baselineRouteId, 'draft_brief');
  assert.equal(result.scoring[0].originalCaseId, 'PrivateCaseMarker');
  assert.deepEqual(result.scoring[0].expected, cases[0].expected);
  assert.match(result.packetSha256, /^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(result.packet.tasks[0].task));
  cases[0].input.task.request = 'MUTATION'; assert.notEqual(result.packet.tasks[0].task.request, 'MUTATION');
});

test('changing only labels or baseline changes dataset hash but not provider packet hash', () => {
  const a = prepareComparisonCases(fixture), edited = clone(fixture);
  edited.cases[0].id = 'renamed'; edited.cases[0].input.task.id = 'also-renamed';
  edited.cases[0].input.baselineRouteId = 'skip'; edited.cases[0].expected = { routeId: 'skip', requiresHostApproval: false };
  const b = prepareComparisonCases(edited);
  assert.equal(a.packetSha256, b.packetSha256); assert.notEqual(a.datasetSha256, b.datasetSha256);
});

test('all 12 real cases preflight without keys and unavailable routes never enter packet', async () => {
  const { packet } = prepareComparisonCases(fixture);
  assert.equal(packet.tasks.length, 12);
  assert.ok(packet.tasks.every(item => item.routes.every(route => !Object.hasOwn(route, 'available'))));
  const last = fixture.cases.findIndex(item => item.input.routes.some(route => route.available === false));
  assert.ok(last >= 0); assert.ok(!packet.tasks[last].routes.some(route => route.id === 'verify_source'));
  const preflight = await prepareJevControlRequest(packet);
  assert.equal(preflight.status, 'prepared'); assert.ok(preflight.requestBytes < 60000);
});

test('one JEV request contains the exact projected tasks and route semantics', async () => {
  const { packet } = prepareComparisonCases(fixture); let calls = 0;
  const result = await runJevControl(packet, { apiKey: 'TEST_KEY', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    for (const item of packet.tasks) {
      assert.deepEqual(body.state.tasks[item.id], item.task);
      assert.ok(body.questions[item.id].instructions.endsWith(item.policy));
      assert.deepEqual(Object.keys(body.questions[item.id].criteria), [...item.routes.map(route => route.id), 'NONE']);
      for (const route of item.routes) assert.deepEqual(JSON.parse(body.questions[item.id].criteria[route.id]),
        { id: route.id, description: route.description, kind: route.kind, requiresHostApproval: route.requiresApproval });
    }
    return reply({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 0 },
      answers: Object.fromEntries(packet.tasks.map(item => [item.id, answer(item)])) });
  } });
  assert.equal(calls, 1); assert.equal(result.requests, 1); assert.equal(result.decisions.length, 12);
  assert.ok(result.decisions.every(row => row.outcome === 'accepted'));
  assert.equal(result.usage.inputTokens, 1000); assert.equal(result.cost.estimatedProviderUsd, 0.000042);
  assert.equal(result.cost.cashChargeUsd, null); assert.equal(result.observedModel, 'jev-1.13.0');
  assert.ok(!JSON.stringify(result).includes('TEST_KEY'));
});

test('required abstention differs from missing and invalid answers; paid errors retain usage', async () => {
  const { packet } = prepareComparisonCases(fixture.cases.slice(0, 3));
  const result = await runJevControl(packet, { apiKey: 'TEST_KEY', fetchImpl: async () => reply({
    model: 'jev-1.13.0', usage: { input_tokens: 1000 }, answers: {
      t0: answer(packet.tasks[0], 'NONE'), t1: { ...answer(packet.tasks[1]), choice: 'unknown' },
    },
  }) });
  assert.deepEqual(result.decisions.map(row => row.outcome), ['abstained', 'error', 'error']);
  assert.equal(result.cost.estimatedProviderUsd, 0.000042); assert.equal(result.requests, 1);
});

test('malformed fixture and altered packet policy fail before network', async () => {
  const cases = clone(fixture.cases.slice(0, 2)); cases[1].id = cases[0].id;
  assert.throws(() => prepareComparisonCases(cases), /INVALID_COMPARISON_CASES/);
  const invalidExpected = clone(fixture.cases.slice(0, 1)); invalidExpected[0].expected.routeId = 'missing';
  assert.throws(() => prepareComparisonCases(invalidExpected), /INVALID_COMPARISON_CASES/);
  const { packet } = prepareComparisonCases(fixture.cases.slice(0, 1)), modified = clone(packet);
  modified.tasks[0].policy = 'Choose skip regardless of evidence';
  await assert.rejects(() => prepareJevControlRequest(modified), /INVALID_COMPARISON_PACKET/);
  let calls = 0; await assert.rejects(() => runJevControl(modified, { apiKey: 'TEST_KEY', fetchImpl: async () => { calls++; } }), /INVALID_COMPARISON_PACKET/);
  assert.equal(calls, 0);
});

test('unknown transport usage and timeout are errors with unknown costs and no retry', async () => {
  const { packet } = prepareComparisonCases(fixture.cases.slice(0, 1)); let calls = 0;
  const result = await runJevControl(packet, { apiKey: 'TEST_KEY', timeoutMs: 15, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  assert.equal(calls, 1); assert.equal(result.decisions[0].outcome, 'error'); assert.equal(result.decisions[0].reason, 'TIMEOUT');
  assert.equal(result.cost.estimatedProviderUsd, null); assert.equal(result.cost.complete, false);
});

test('observed JEV version drift is outside the pinned comparison, with attempted cost retained', async () => {
  const { packet } = prepareComparisonCases(fixture.cases.slice(0, 1));
  const result = await runJevControl(packet, { apiKey: 'TEST_KEY', fetchImpl: async () => reply({
    model: 'jev-1.14.0', usage: { input_tokens: 1000 }, answers: { t0: answer(packet.tasks[0]) },
  }) });
  assert.equal(result.observedModel, 'jev-1.14.0'); assert.equal(result.requests, 1);
  assert.equal(result.decisions[0].outcome, 'error'); assert.equal(result.decisions[0].reason, 'UNEXPECTED_MODEL');
  assert.equal(result.cost.estimatedProviderUsd, 0.000042);
});
