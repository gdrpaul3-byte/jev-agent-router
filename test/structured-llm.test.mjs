import test from 'node:test';
import assert from 'node:assert/strict';

const subject = () => import('../src/structured-llm.mjs');
const schema = () => ({ type: 'object', properties: { routeId: { type: 'string', enum: ['read', 'NONE'] } }, required: ['routeId'], additionalProperties: false });
const request = () => ({ model: 'openai/gpt-6-luna', instructions: 'Return a safe supported route.', context: 'FIXED_CONTEXT', input: { task: 'DYNAMIC_PRIVATE_TASK' }, schema: schema() });
const payload = (value = { routeId: 'read' }, extra = {}) => ({ model: 'openai/gpt-6-luna-20260922', provider: 'OpenAI', service_tier: 'default',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 20 }, cost: .001, is_byok: false, cost_details: { upstream_inference_cost: .0009 } }, ...extra });
const run = async (data = request(), options = {}) => (await subject()).runStructuredRequest(data, { apiKey: 'mock-key', fetchImpl: async () => Response.json(payload()), ...options });

test('preflight snapshots an explicit cache boundary before dynamic JSON, with a fixed strict schema and no tools', async () => {
  const { prepareStructuredRequest } = await subject();
  const data = request(); const prepared = prepareStructuredRequest(data, { cacheKey: 'workflow/routes:scope-1' });
  assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.status, 'prepared'); assert.equal(prepared.requestBytes, Buffer.byteLength(prepared.body));
  assert.equal(prepared.requestedModel, data.model); const body = JSON.parse(prepared.body);
  assert.deepEqual(body.messages, [{ role: 'system', content: data.instructions }, { role: 'user', content: [
    { type: 'text', text: data.context, prompt_cache_breakpoint: { mode: 'explicit' } }, { type: 'text', text: JSON.stringify(data.input) },
  ] }]);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' }); assert.equal(body.prompt_cache_key, 'workflow/routes:scope-1');
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'structured_task', strict: true, schema: data.schema } });
  assert.deepEqual(body.provider, { only: ['openai'], ignore: ['openai/flex', 'openai/fast'], allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.service_tier, 'default'); assert.equal(body.stream, false);
  assert.deepEqual(body.reasoning, { effort: 'none' }); assert.equal(body.max_tokens, 2048);
  for (const field of ['previous_response_id', 'conversation', 'plugins', 'transforms']) assert.equal(Object.hasOwn(body, field), false);
  data.schema.properties.routeId.enum.push('write'); data.input.task = 'AFTER_PREPARE'; assert.ok(!prepared.body.includes('AFTER_PREPARE'));
});

test('cache off retains explicit mode without a breakpoint, and Astra uses supported low reasoning', async () => {
  const { prepareStructuredRequest } = await subject(); const data = { ...request(), model: 'openai/gpt-6-astra' };
  const body = JSON.parse(prepareStructuredRequest(data, { cacheMode: 'off', maxOutputTokens: 4096 }).body);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' }); assert.ok(!JSON.stringify(body).includes('prompt_cache_breakpoint'));
  assert.equal(Object.hasOwn(body, 'prompt_cache_key'), false); assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.max_tokens, 4096);
});

test('strict request/config validation rejects unknown fields, hooks, cycles, oversized bodies and unsupported models before network', async () => {
  const { prepareStructuredRequest } = await subject();
  for (const mutate of [r => { r.expected = 'PRIVATE_LABEL'; }, r => { r.model = 'openai/gpt-other'; }, r => { r.input.self = r.input; },
    r => { Object.defineProperty(r.input, 'secret', { get() { assert.fail('getter invoked'); } }); },
    r => { r.input = [undefined]; }, r => { r.input = new Date(); }, r => { r.input = { n: Infinity }; },
    r => { r.schema.toJSON = () => assert.fail('toJSON invoked'); }, r => { r.instructions = ''; }]) {
    const data = request(); mutate(data); assert.throws(() => prepareStructuredRequest(data), /^(Error: INVALID_INPUT|Error: INVALID_SCHEMA)$/);
    const result = await run(data, { fetchImpl: async () => assert.fail('no dispatch') }); assert.equal(result.requests, 0); assert.equal(result.status, 'error');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_LABEL'));
  }
  const huge = request(); huge.context = '한'.repeat(40000); assert.throws(() => prepareStructuredRequest(huge), /^Error: INPUT_TOO_LARGE$/);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 120001 }, { maxOutputTokens: 0 }, { maxOutputTokens: 16385 },
    { cacheMode: 'automatic' }, { cacheKey: '' }, { cacheKey: 'bad\nkey' }, { endpoint: 'https://other.invalid' }])
    assert.throws(() => prepareStructuredRequest(request(), options), /^Error: INVALID_CONFIGURATION$/);
});

test('schema subset rejects unsupported or inconsistent constraints instead of silently ignoring them', async () => {
  const { prepareStructuredRequest } = await subject();
  const invalid = [ { type: 'array', items: { type: 'string' } }, { ...schema(), additionalProperties: true }, { ...schema(), required: [] },
    { ...schema(), required: ['routeId', 'unknown'] }, { ...schema(), required: ['routeId', 'routeId'] },
    { ...schema(), properties: { routeId: { type: 'string', pattern: '.*' } } },
    { ...schema(), properties: { routeId: { anyOf: [{ type: 'string' }] } } },
    { ...schema(), properties: { routeId: { type: 'string', minLength: 5, maxLength: 1 } } },
    { ...schema(), properties: { routeId: { type: 'integer', enum: ['wrong-type'] } } },
    { ...schema(), properties: { routeId: { type: 'number', minimum: Infinity } } },
    { ...schema(), properties: { routeId: { type: 'string', enum: [] } } },
    { ...schema(), properties: { routeId: { type: 'array' } } },
  ];
  for (const value of invalid) assert.throws(() => prepareStructuredRequest({ ...request(), schema: value }), /^Error: INVALID_SCHEMA$/);
});

test('one POST returns a validated result and preserved observed provider evidence without report secrets', async () => {
  let calls = 0; const data = request();
  const result = await run(data, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer mock-key'); assert.ok(options.signal instanceof AbortSignal);
    data.schema.properties.routeId.enum = ['wrong']; return Response.json(payload());
  } });
  assert.equal(calls, 1); assert.equal(result.requests, 1); assert.equal(result.status, 'ok'); assert.equal(result.reason, null);
  assert.deepEqual(result.value, { routeId: 'read' }); assert.ok(Object.isFrozen(result.value)); assert.equal(result.httpStatus, 200);
  assert.equal(result.requestedModel, 'openai/gpt-6-luna'); assert.equal(result.observedModel, 'openai/gpt-6-luna-20260922');
  assert.equal(result.observedProvider, 'OpenAI'); assert.equal(result.observedServiceTier, 'default'); assert.ok(result.latencyMs >= 0);
  assert.ok(!JSON.stringify(result).includes('mock-key')); assert.ok(!JSON.stringify(result).includes('DYNAMIC_PRIVATE_TASK'));
});

test('nested types, enum, const and lower/upper bounds are actually checked on model output', async () => {
  const object = { type: 'object', properties: {
    n: { type: 'integer', minimum: 0, maximum: 3 }, score: { type: 'number', minimum: 0, maximum: 1 },
    label: { type: 'string', minLength: 1, maxLength: 2 }, ok: { type: 'boolean', const: true }, empty: { type: 'null' },
  }, required: ['n', 'score', 'label', 'ok', 'empty'], additionalProperties: false };
  const complex = { type: 'object', properties: { items: { type: 'array', items: object, minItems: 1, maxItems: 2 } }, required: ['items'], additionalProperties: false };
  const value = { items: [{ n: 2, score: .5, label: '🙂', ok: true, empty: null }] }; const data = { ...request(), schema: complex };
  assert.equal((await run(data, { fetchImpl: async () => Response.json(payload(value)) })).status, 'ok');
  for (const mutate of [v => { v.extra = 1; }, v => { v.items = []; }, v => { v.items.push(v.items[0], v.items[0]); },
    v => { v.items[0].n = 1.5; }, v => { v.items[0].n = 4; }, v => { v.items[0].score = -.1; },
    v => { v.items[0].label = 'abc'; }, v => { v.items[0].label = ''; }, v => { v.items[0].ok = false; },
    v => { v.items[0].empty = 'null'; }, v => { delete v.items[0].score; }, v => { v.items[0].unknown = 1; }]) {
    const bad = structuredClone(value); mutate(bad); const result = await run(data, { fetchImpl: async () => Response.json(payload(bad)) });
    assert.equal(result.status, 'error'); assert.equal(result.reason, 'INVALID_OUTPUT'); assert.equal(result.value, null); assert.equal(result.cost.reportedProviderUsd, .001);
  }
  const invalidEnum = await run(undefined, { fetchImpl: async () => Response.json(payload({ routeId: 'write' })) }); assert.equal(invalidEnum.reason, 'INVALID_OUTPUT');
});

test('response envelopes reject model/provider/tier drift, tools, refusal, partial outputs and ambiguous messages', async () => {
  const cases = [[{ model: 'openai/gpt-6-astra' }, 'UNEXPECTED_MODEL'], [{ model: 'secret-model' }, 'UNEXPECTED_MODEL'],
    [{ provider: 'Azure' }, 'UNEXPECTED_PROVIDER'], [{ service_tier: 'fast' }, 'UNEXPECTED_SERVICE_TIER'],
    [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{}] } }] }, 'UNEXPECTED_TOOL'],
    [{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }, 'INCOMPLETE_RESPONSE'],
    [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'PRIVATE_REFUSAL' } }] }, 'REFUSAL'],
    [{ error: { message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_ERROR'], [{ choices: [] }, 'INVALID_RESPONSE'],
    [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{}\n```' } }] }, 'INVALID_OUTPUT'],
  ];
  for (const [extra, reason] of cases) {
    const result = await run(undefined, { fetchImpl: async () => Response.json(payload(undefined, extra)) });
    assert.equal(result.status, 'error'); assert.equal(result.reason, reason); assert.equal(result.value, null); assert.equal(result.usage.inputTokens, 1000);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('secret-model'));
  }
  const astra = await run({ ...request(), model: 'openai/gpt-6-astra' }, { fetchImpl: async () => Response.json(payload(undefined, { model: 'openai/gpt-6-astra-20260903' })) });
  assert.equal(astra.status, 'ok'); assert.equal(astra.observedModel, 'openai/gpt-6-astra-20260903');
});

test('usage categories and account-credit charges remain distinct, including known zero and missing counts', async () => {
  const result = await run();
  assert.deepEqual(result.usage, { inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 300, outputTokens: 100, reasoningTokens: 20 });
  assert.equal(result.cost.reportedProviderUsd, .001); assert.equal(result.cost.knownUsageUsd, .001); assert.equal(result.cost.estimatedProviderUsd, null);
  assert.equal(result.cost.cashChargeUsd, null); assert.equal(result.cost.complete, true); assert.equal(result.cost.basis, 'provider_reported_credit_charge');
  assert.equal(result.cost.billingScope, 'openrouter_account_credits'); assert.equal(result.cost.upstreamInferenceCostUsd, .0009); assert.equal(result.cost.isByok, false);
  for (const cost of [undefined, null, -1, '0.01', 0]) {
    const partial = await run(undefined, { fetchImpl: async () => Response.json(payload(undefined, { usage: { cost } })) });
    assert.equal(partial.cost.reportedProviderUsd, cost === 0 ? 0 : null); assert.equal(partial.cost.complete, cost === 0);
    assert.equal(partial.usage.inputTokens, null); assert.equal(partial.usage.cacheWriteTokens, null);
  }
});

test('HTTP failure preserves available usage and status while transport failures do not retry', async () => {
  let calls = 0;
  const result = await run(undefined, { fetchImpl: async () => { calls++; return Response.json(payload(undefined, { error: { message: 'mock-key PRIVATE_SERVER' } }), { status: 429 }); } });
  assert.equal(result.reason, 'HTTP_ERROR'); assert.equal(result.httpStatus, 429); assert.equal(result.requests, 1); assert.equal(calls, 1);
  assert.equal(result.cost.reportedProviderUsd, .001); assert.equal(result.value, null); assert.ok(!JSON.stringify(result).includes('PRIVATE_SERVER'));
  const failed = await run(undefined, { fetchImpl: async () => { throw new Error('mock-key'); } });
  assert.equal(failed.reason, 'REQUEST_FAILED'); assert.equal(failed.requests, 1); assert.equal(failed.httpStatus, null); assert.equal(failed.cost.reportedProviderUsd, null);
});

test('deadline covers fetch and JSON parsing and aborts without late result mutation', async () => {
  for (const stage of ['fetch', 'json']) {
    let release; let signal; const pending = new Promise(resolve => { release = resolve; });
    const result = await run(undefined, { timeoutMs: 10, fetchImpl: async (_url, init) => { signal = init.signal; return stage === 'fetch' ? pending : { ok: true, status: 200, json: () => pending }; } });
    assert.equal(result.reason, 'TIMEOUT'); assert.equal(signal.aborted, true); assert.equal(result.requests, 1); assert.equal(result.value, null);
    const before = JSON.stringify(result); release(stage === 'fetch' ? Response.json(payload()) : payload());
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(JSON.stringify(result), before);
  }
});

test('synchronous JSON completion after the deadline cannot be accepted', async () => {
  const result = await run(undefined, { timeoutMs: 5, fetchImpl: async () => ({ ok: true, status: 200, json() {
    const until = performance.now() + 15; while (performance.now() < until) {} return payload();
  } }) });
  assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.value, null); assert.equal(result.cost.reportedProviderUsd, .001);
});

test('missing credentials and invalid transport never dispatch and never disclose supplied credentials', async () => {
  for (const [options, reason] of [[{ apiKey: '' }, 'MISSING_API_KEY'], [{ apiKey: 'private\r\nkey' }, 'INVALID_CONFIGURATION'], [{ fetchImpl: null }, 'INVALID_CONFIGURATION']]) {
    const result = await run(undefined, { fetchImpl: async () => assert.fail('no dispatch'), ...options });
    assert.equal(result.reason, reason); assert.equal(result.status, 'error'); assert.equal(result.requests, 0); assert.equal(result.httpStatus, null);
    assert.ok(!JSON.stringify(result).includes('private')); assert.equal(result.value, null);
  }
});

test('model allowlisting never coerces caller objects into a model name', async () => {
  const { prepareStructuredRequest } = await subject(); let coercions = 0;
  const data = { ...request(), model: { toString() { coercions++; return 'openai/gpt-6-luna'; } } };
  assert.throws(() => prepareStructuredRequest(data), /^Error: INVALID_INPUT$/);
  const result = await run(data, { fetchImpl: async () => assert.fail('no dispatch') });
  assert.equal(result.reason, 'INVALID_INPUT'); assert.equal(result.requests, 0); assert.equal(result.requestedModel, null); assert.equal(coercions, 0);
});
