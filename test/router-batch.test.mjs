import test from 'node:test';
import assert from 'node:assert/strict';

const subject = () => import('../src/router-batch.mjs');
const sample = (id = 'one') => ({ task: { id, revision: 1, request: `Route task ${id}`, progress: `Progress ${id}`, evidence: [{ id: 'e1', text: `Evidence ${id}` }] },
  routes: [{ id: 'read', description: 'Read missing facts', kind: 'read' }, { id: 'write', description: 'Publish final draft', kind: 'write' }, { id: 'hidden', description: 'NEVER_SENT', kind: 'draft', available: false }], baselineRouteId: 'read' });
const choice = (routeId = 'read') => ({ type: 'choice', choice: routeId, confidence: 0.96,
  probabilities: { read: routeId === 'read' ? 0.94 : 0.03, write: routeId === 'write' ? 0.94 : 0.03, NONE: routeId === 'NONE' ? 0.94 : 0.03 } });
const response = (answers = { t0: choice(), t1: choice('write') }, extra = {}) => Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 300, output_tokens: 0 }, answers, ...extra });
const run = async (inputs = [sample(), sample('two')], options = {}) => (await subject()).decideRouteBatch(inputs, {
  apiKey: 'test-key-only', fetchImpl: async () => response(), ...options,
});

test('independent task views and exact questions share one metered official request', async () => {
  let calls = 0;
  const result = await run(undefined, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.model, 'jev-1.13.0');
    assert.deepEqual(Object.keys(body.questions), ['t0', 't1']); assert.deepEqual(Object.keys(body.state.tasks), ['t0', 't1']);
    for (const [index, id] of ['one', 'two'].entries()) {
      const question = body.questions[`t${index}`]; assert.equal(body.state.tasks[`t${index}`].id, id);
      assert.ok(question.instructions.includes(`state.tasks.t${index}`)); assert.match(question.instructions, /only|independent/i);
      assert.deepEqual(Object.keys(question.criteria), ['read', 'write', 'NONE']);
    }
    assert.ok(!options.body.includes('NEVER_SENT')); return response();
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'decided'); assert.equal(result.previewOnly, true); assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.decisions.map(item => [item.taskId, item.revision, item.routeId, item.requiresHostApproval]), [['one', 1, 'read', false], ['two', 1, 'write', true]]);
  assert.equal(result.cost.calls, 1); assert.equal(result.cost.inputTokens, 300); assert.equal(result.requests.length, 1); assert.equal(result.requests[0].questionCount, 2);
  for (const item of result.decisions) for (const forbidden of ['cost', 'requests', 'inputTokens', 'latencyMs']) assert.equal(Object.hasOwn(item, forbidden), false);
  assert.ok(result.latencyMs >= 0); assert.equal(Object.hasOwn(result, 'handoffPath'), false);
});

test('batch cardinality, duplicate task IDs and invalid inputs fail before dispatch', async () => {
  const sparse = [sample(), sample('two')]; delete sparse[1];
  const custom = [sample()]; custom.toJSON = () => assert.fail('must not call');
  const invalid = sample(); invalid.task.secret = 'PRIVATE_DATA';
  for (const inputs of [[], Array.from({ length: 17 }, (_, i) => sample(`t${i}`)), [sample(), sample()], [invalid], sparse, custom]) {
    const result = await run(inputs, { fetchImpl: async () => assert.fail('no request') });
    assert.equal(result.status, 'needs_host'); assert.equal(result.reason, 'INVALID_INPUT'); assert.equal(result.cost.calls, 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_DATA'));
  }
});

test('active execution mode and unknown config are rejected without network', async () => {
  for (const config of [{ mode: 'active' }, { mode: 'active', enabled: false }, { secret: 'PRIVATE_CONFIG' }]) {
    const result = await run(undefined, { config, fetchImpl: async () => assert.fail('no request') });
    assert.equal(result.reason, 'INVALID_CONFIGURATION'); assert.equal(result.cost.calls, 0);
  }
});

test('disabled and dry-run work without credentials and report zero calls', async () => {
  const fetchImpl = async () => assert.fail('no request');
  const disabled = await run(undefined, { apiKey: '', config: { enabled: false, maxCalls: 0 }, fetchImpl });
  assert.equal(disabled.status, 'bypassed'); assert.deepEqual(disabled.decisions.map(item => item.routeId), ['read', 'read']); assert.equal(disabled.cost.estimatedJevUsd, 0);
  const dry = await run(undefined, { apiKey: '', config: { mode: 'dry-run', maxCalls: 0 }, fetchImpl });
  assert.equal(dry.status, 'dry_run'); assert.ok(dry.requestBytes > 0); assert.equal(dry.cost.calls, 0); assert.equal(dry.requests.length, 0);
  assert.deepEqual(dry.tasks.map(item => item.eligibleRouteIds), [['read', 'write'], ['read', 'write']]);
});

test('total UTF-8 batch size is bounded before credentials, even when individual inputs fit', async () => {
  const inputs = [sample(), sample('two')]; inputs[0].task.evidence[0].text = '한글'.repeat(500);
  const core = await import('../src/router.mjs');
  const maxIndividual = Math.max(...inputs.map(input => Buffer.byteLength(core.prepareRouteRequest(input, { maxInputBytes: 100000 }).body)));
  const result = await run(inputs, { apiKey: '', config: { maxInputBytes: maxIndividual + 100 }, fetchImpl: async () => assert.fail('no request') });
  assert.equal(result.reason, 'INPUT_TOO_LARGE'); assert.equal(result.cost.calls, 0);
});

test('zero call budget and invalid credentials cannot dispatch', async () => {
  for (const [options, reason] of [[{ config: { maxCalls: 0 } }, 'CALL_BUDGET_EXHAUSTED'], [{ apiKey: '' }, 'MISSING_API_KEY'], [{ apiKey: 'x\r\ny' }, 'INVALID_CONFIGURATION'], [{ fetchImpl: null }, 'INVALID_CONFIGURATION']]) {
    const result = await run(undefined, options); assert.equal(result.reason, reason); assert.equal(result.cost.calls, 0);
  }
});

test('missing or malformed individual answers preserve the other independent decision', async () => {
  for (const bad of [undefined, null, { ...choice(), choice: 'hidden' }, { ...choice(), probabilities: { read: 0.95, write: 0.03, NONE: 0.03 } }, { ...choice(), probabilities: { read: 0.5, write: 0.5, NONE: 0 } }]) {
    const answers = { t0: choice() }; if (bad !== undefined) answers.t1 = bad;
    const result = await run(undefined, { fetchImpl: async () => response(answers) });
    assert.equal(result.status, 'decided'); assert.equal(result.decisions[0].status, 'selected');
    assert.equal(result.decisions[1].status, 'needs_host'); assert.equal(result.decisions[1].reason, 'INVALID_RESPONSE'); assert.equal(result.cost.calls, 1);
  }
});

test('routes from a different task cannot enter the local choice set', async () => {
  const inputs = [sample(), sample('two')]; inputs[1].routes = [{ id: 'review', description: 'Review supplied draft', kind: 'draft' }]; inputs[1].baselineRouteId = 'review';
  const result = await run(inputs, { fetchImpl: async () => response({ t0: choice(), t1: choice() }) });
  assert.equal(result.decisions[1].reason, 'INVALID_RESPONSE');
});

test('extra answer IDs and invalid shared envelope reject the entire batch', async () => {
  for (const make of [() => response({ t0: choice(), t1: choice(), t2: choice() }), () => response(null),
    () => response(undefined, { model: 'jev-1.13.0\nPRIVATE_PROVIDER' }), () => response(undefined, { usage: null }),
    () => response(undefined, { usage: { input_tokens: -1 } })]) {
    const result = await run(undefined, { fetchImpl: async () => make() });
    assert.equal(result.status, 'needs_host'); assert.equal(result.reason, 'INVALID_RESPONSE'); assert.equal(Object.hasOwn(result, 'decisions'), false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER'));
  }
});

test('per-item NONE and confidence/margin failures retain only validated numeric diagnostics', async () => {
  for (const [answer, reason] of [[choice('NONE'), 'NO_SAFE_ROUTE'], [{ ...choice(), confidence: 0.7 }, 'LOW_CONFIDENCE'],
    [{ ...choice(), probabilities: { read: 0.52, write: 0.45, NONE: 0.03 } }, 'AMBIGUOUS_ROUTE']]) {
    answer.explanation = 'PRIVATE_PROVIDER';
    const result = await run(undefined, { fetchImpl: async () => response({ t0: choice(), t1: answer }) });
    assert.equal(result.decisions[1].reason, reason); assert.ok(Number.isFinite(result.decisions[1].confidence));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER'));
  }
});

test('unknown shared usage is not allocated as zero or split between items', async () => {
  const result = await run(undefined, { fetchImpl: async () => response(undefined, { usage: undefined }) });
  assert.equal(result.reason, 'INVALID_RESPONSE'); assert.equal(result.cost.estimatedJevUsd, null); assert.equal(result.cost.inputTokens, null);
  assert.equal(result.cost.calls, 1); assert.equal(result.requests.length, 1);
});

test('HTTP and transport failures are sanitized and never retry', async () => {
  for (const [fetchImpl, reason] of [[async () => ({ ok: false, status: 500, json: () => assert.fail('no body') }), 'HTTP_ERROR'],
    [async () => { throw new Error('PRIVATE_KEY'); }, 'REQUEST_FAILED']]) {
    let calls = 0; const result = await run(undefined, { fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    assert.equal(result.reason, reason); assert.equal(calls, 1); assert.equal(result.cost.calls, 1); assert.equal(result.cost.estimatedJevUsd, null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_KEY'));
  }
});

test('timeout includes JSON, aborts ignored transports, and late replies cannot mutate billing snapshots', async () => {
  for (const stage of ['fetch', 'json']) {
    let release; let signal; const started = performance.now();
    const result = await run(undefined, { config: { timeoutMs: 15 }, fetchImpl: async (_url, options) => {
      signal = options.signal; if (stage === 'fetch') return new Promise(resolve => { release = () => resolve(response()); });
      return { ok: true, json: () => new Promise(resolve => { release = () => resolve({ model: 'jev-1.13.0', usage: { input_tokens: 300 }, answers: { t0: choice(), t1: choice() } }); }) };
    } });
    assert.equal(result.reason, 'TIMEOUT'); assert.equal(signal.aborted, true); assert.ok(performance.now() - started < 500);
    assert.equal(result.cost.estimatedJevUsd, null); const saved = JSON.stringify(result);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(JSON.stringify(result), saved);
  }
});

test('post-dispatch caller mutation cannot revise frozen task identities and approvals', async () => {
  const inputs = [sample(), sample('two')]; let release;
  const pending = run(inputs, { fetchImpl: () => new Promise(resolve => { release = () => resolve(response()); }) });
  await new Promise(resolve => setImmediate(resolve)); inputs[1].task.id = 'changed'; inputs[1].routes[1].kind = 'draft';
  release(); const result = await pending; assert.equal(result.decisions[1].taskId, 'two'); assert.equal(result.decisions[1].requiresHostApproval, true);
});
