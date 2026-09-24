import test from 'node:test';
import assert from 'node:assert/strict';

const subject = () => import('../benchmarks/llm-control-openrouter.mjs');
const packet = () => ({ tasks: [{ id: 't0', task: { id: 't0', revision: 1, request: 'PRIVATE_TASK', progress: '', evidence: [] },
  routes: [{ id: 'read', description: 'Read evidence', kind: 'read', requiresApproval: false },
    { id: 'write', description: 'Publish final', kind: 'write', requiresApproval: true }], policy: 'Choose safe next route or NONE.' },
  { id: 't1', task: { id: 't1', revision: 1, request: 'PRIVATE_SECOND_TASK', progress: '', evidence: [] },
    routes: [{ id: 'draft', description: 'Draft content', kind: 'draft', requiresApproval: false }], policy: 'Choose safe next route or NONE.' }] });
const reply = (decisions = [{ id: 't0', routeId: 'write' }, { id: 't1', routeId: 'draft' }], extra = {}) => ({
  model: 'openai/gpt-6-luna-20260922', provider: 'OpenAI',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ decisions }) } }],
  usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 0 },
    cost: .00017, cost_details: { upstream_inference_cost: .00015 } }, ...extra,
});
const run = async (data = packet(), options = {}) => (await subject()).runOpenRouterControl(data, {
  apiKey: 'mock-openrouter-key', fetchImpl: async () => Response.json(reply()), ...options,
});
const allErrors = (result, reason) => assert.ok(result.decisions.every(item => item.outcome === 'error' && item.reason === reason));

test('preflight reuses the exact policy/data/schema while pinning the tool-free OpenRouter route', async () => {
  const { prepareOpenRouterControlRequest } = await subject();
  const direct = (await import('../benchmarks/llm-control-openai.mjs')).prepareOpenAiControlRequest(packet());
  const prepared = prepareOpenRouterControlRequest(packet()); const body = JSON.parse(prepared.body); const directBody = JSON.parse(direct.body);
  assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.requestedModel, 'openai/gpt-6-luna');
  assert.equal(prepared.requestBytes, Buffer.byteLength(prepared.body));
  assert.deepEqual(body.messages, [{ role: 'system', content: directBody.instructions }, ...directBody.input]);
  assert.deepEqual(body.response_format.json_schema.schema, directBody.text.format.schema);
  assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.provider, { only: ['openai'], ignore: ['openai/flex', 'openai/fast'], allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.stream, false);
  assert.equal(body.service_tier, 'default');
  assert.deepEqual(body.reasoning, { effort: 'none' }); assert.equal(body.max_tokens, 2048);
  for (const field of ['previous_response_id', 'conversation', 'plugins', 'transforms', 'models', 'route', 'store']) assert.equal(Object.hasOwn(body, field), false);
});

test('one OpenRouter POST preserves actual model/provider and prices only the reported credit charge', async () => {
  let calls = 0;
  const result = await run(undefined, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer mock-openrouter-key');
    assert.equal(JSON.parse(options.body).model, 'openai/gpt-6-luna'); return Response.json(reply());
  } });
  assert.equal(calls, 1); assert.equal(result.requests, 1); assert.equal(result.httpStatus, 200);
  assert.equal(result.requestedModel, 'openai/gpt-6-luna'); assert.equal(result.observedModel, 'openai/gpt-6-luna-20260922');
  assert.equal(result.observedProvider, 'OpenAI'); assert.equal(result.observedServiceTier, null);
  assert.deepEqual(result.decisions.map(item => [item.id, item.outcome, item.routeId, item.requiresHostApproval]), [['t0', 'accepted', 'write', true], ['t1', 'accepted', 'draft', false]]);
  assert.deepEqual(result.usage, { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 0 });
  assert.equal(result.cost.reportedProviderUsd, .00017); assert.equal(result.cost.upstreamInferenceCostUsd, .00015);
  assert.equal(result.cost.estimatedProviderUsd, null); assert.equal(result.cost.knownUsageUsd, .00017); assert.equal(result.cost.complete, true);
  assert.equal(result.cost.cashChargeUsd, null); assert.equal(result.cost.basis, 'provider_reported_credit_charge');
  assert.equal(result.cost.billingScope, 'openrouter_account_credits'); assert.equal(result.cost.isByok, null);
  assert.equal(result.cost.pricingSource, 'https://openrouter.ai/docs/cookbook/administration/usage-accounting');
  assert.ok(result.wallLatencyMs >= 0); assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('mock-openrouter-key'));
});

test('alias is accepted but a wrong model, provider, tool action, partial or malformed reply never becomes an abstention', async () => {
  const good = await run(undefined, { fetchImpl: async () => Response.json(reply(undefined, { model: 'openai/gpt-6-luna' })) });
  assert.equal(good.decisions[0].outcome, 'accepted');
  const cases = [[{ model: 'openai/gpt-6-astra' }, 'UNEXPECTED_MODEL'], [{ provider: 'Azure' }, 'UNEXPECTED_PROVIDER'],
    [{ provider: undefined }, 'UNEXPECTED_PROVIDER'],
    [{ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ type: 'function' }] } }] }, 'UNEXPECTED_TOOL'],
    [{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{' } }] }, 'INCOMPLETE_RESPONSE'],
    [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'invalid json' } }] }, 'INVALID_RESPONSE'],
    [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'PRIVATE_REFUSAL' } }] }, 'REFUSAL'],
    [{ choices: [] }, 'INVALID_RESPONSE']];
  for (const [extra, reason] of cases) {
    const result = await run(undefined, { fetchImpl: async () => Response.json(reply(undefined, extra)) });
    allErrors(result, reason); assert.equal(result.cost.reportedProviderUsd, .00017); assert.ok(!JSON.stringify(result).includes('PRIVATE_REFUSAL'));
  }
});

test('shared decision validation separates NONE, omitted answers and task-specific invalid choices', async () => {
  let result = await run(undefined, { fetchImpl: async () => Response.json(reply([{ id: 't0', routeId: 'NONE' }])) });
  assert.equal(result.decisions[0].outcome, 'abstained'); assert.equal(result.decisions[1].reason, 'MISSING_DECISION');
  result = await run(undefined, { fetchImpl: async () => Response.json(reply([{ id: 't0', routeId: 'draft' }, { id: 't1', routeId: 'draft' }])) });
  assert.equal(result.decisions[0].reason, 'INVALID_CHOICE'); assert.equal(result.decisions[1].outcome, 'accepted');
  for (const decisions of [[{ id: 't0', routeId: 'read' }, { id: 't0', routeId: 'read' }], [{ id: 'unknown', routeId: 'read' }]])
    allErrors(await run(undefined, { fetchImpl: async () => Response.json(reply(decisions)) }), 'INVALID_RESPONSE');
});

test('reported charge zero is known, missing or invalid charges stay unknown with no OpenAI rate fallback', async () => {
  for (const cost of [undefined, null, -1, '0.001', Infinity]) {
    const value = reply(); value.usage.cost = cost;
    const result = await run(undefined, { fetchImpl: async () => Response.json(value) });
    assert.equal(result.cost.reportedProviderUsd, null); assert.equal(result.cost.estimatedProviderUsd, null);
    assert.equal(result.cost.knownUsageUsd, null); assert.equal(result.cost.complete, false);
  }
  const value = reply(); value.usage = { cost: 0 };
  const result = await run(undefined, { fetchImpl: async () => Response.json(value) });
  assert.equal(result.cost.reportedProviderUsd, 0); assert.equal(result.cost.knownUsageUsd, 0); assert.equal(result.cost.complete, true);
  assert.equal(result.usage.inputTokens, null); assert.equal(result.usage.cacheWriteInputTokens, null);
});

test('HTTP diagnostics preserve allowed numeric codes but never reflect arbitrary error strings or metadata', async () => {
  for (const code of [401, '402', 'mock-openrouter-key']) {
    const result = await run(undefined, { fetchImpl: async () => Response.json({ error: {
      code, type: 'PRIVATE_TYPE', message: 'mock-openrouter-key PRIVATE_MESSAGE', metadata: { raw: 'PRIVATE_UPSTREAM' },
    }, usage: { cost: .00001 } }, { status: 401 }) });
    allErrors(result, 'HTTP_ERROR'); assert.equal(result.httpStatus, 401);
    assert.equal(result.providerErrorCode, code === 'mock-openrouter-key' ? null : String(code));
    assert.equal(result.providerErrorType, null); assert.equal(result.cost.reportedProviderUsd, .00001);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('mock-openrouter-key'));
  }
});

test('validation and credential failures do not dispatch, and request preparation is bounded before credentials', async () => {
  const { prepareOpenRouterControlRequest } = await subject();
  const invalid = packet(); invalid.tasks[0].expected = 'PRIVATE_LABEL';
  assert.throws(() => prepareOpenRouterControlRequest(invalid), /^Error: INVALID_INPUT$/);
  assert.throws(() => prepareOpenRouterControlRequest(packet(), { model: 'openai/gpt-6-astra' }), /^Error: INVALID_CONFIGURATION$/);
  const huge = packet(); huge.tasks[0].task.request = 'x'.repeat(110000);
  assert.throws(() => prepareOpenRouterControlRequest(huge), /^Error: INPUT_TOO_LARGE$/);
  for (const [data, options, reason] of [[invalid, {}, 'INVALID_INPUT'], [huge, { apiKey: '' }, 'INPUT_TOO_LARGE'],
    [packet(), { apiKey: '' }, 'MISSING_API_KEY'], [packet(), { model: 'bad' }, 'INVALID_CONFIGURATION'],
    [packet(), { fetchImpl: null }, 'INVALID_CONFIGURATION']]) {
    const result = await run(data, { fetchImpl: async () => assert.fail('no call'), ...options });
    assert.equal(result.requests, 0); allErrors(result, reason); assert.ok(!JSON.stringify(result).includes('PRIVATE_LABEL'));
  }
});

test('one deadline bounds JSON parsing and ignores late model/provider/cost evidence', async () => {
  let release; let signal;
  const result = await run(undefined, { timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal; return { ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) };
  } });
  allErrors(result, 'TIMEOUT'); assert.equal(signal.aborted, true); assert.equal(result.requests, 1);
  assert.equal(result.observedModel, null); assert.equal(result.observedProvider, null); assert.equal(result.cost.reportedProviderUsd, null);
  const before = JSON.stringify(result); release(reply()); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.stringify(result), before);
});

test('BYOK flags are explicit booleans and never expand account-credit completeness into upstream spending', async () => {
  for (const isByok of [true, false, undefined, 'PRIVATE_VALUE']) {
    const value = reply(); value.usage.is_byok = isByok;
    const result = await run(undefined, { fetchImpl: async () => Response.json(value) });
    assert.equal(result.cost.isByok, typeof isByok === 'boolean' ? isByok : null);
    assert.equal(result.cost.billingScope, 'openrouter_account_credits'); assert.equal(result.cost.complete, true);
    assert.equal(result.cost.knownUsageUsd, .00017); assert.equal(result.cost.upstreamInferenceCostUsd, .00015);
    assert.equal(Object.hasOwn(result.cost, 'reportedUpstreamInferenceUsd'), false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
  }
});

test('observed service tier is retained only from an allowlisted response value', async () => {
  for (const serviceTier of ['default', 'flex', 'fast', 'priority', undefined, 'PRIVATE_TIER']) {
    const result = await run(undefined, { fetchImpl: async () => Response.json(reply(undefined, { service_tier: serviceTier })) });
    assert.equal(result.observedServiceTier, ['default', 'flex', 'fast', 'priority'].includes(serviceTier) ? serviceTier : null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TIER'));
  }
});
