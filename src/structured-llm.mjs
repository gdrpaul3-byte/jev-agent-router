// Pure preparation + one bounded OpenRouter request; no retries, execution or history.
// Cache controls: https://openrouter.ai/docs/guides/best-practices/prompt-caching
// Astra low: https://developers.openai.com/api/docs/models/gpt-6-astra
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_BYTES = 100000;
const MODELS = Object.freeze({
  'openai/gpt-6-luna': { effort: 'none', observed: ['openai/gpt-6-luna', 'openai/gpt-6-luna-20260922'] },
  'openai/gpt-6-astra': { effort: 'low', observed: ['openai/gpt-6-astra', 'openai/gpt-6-astra-20260903'] },
}); // Snapshots verified via public OpenRouter model endpoints on 2026-09-24.
const OBSERVED_MODELS = new Set(Object.values(MODELS).flatMap(model => model.observed));
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const CONFIG_KEYS = ['apiKey', 'fetchImpl', 'timeoutMs', 'maxOutputTokens', 'cacheMode', 'cacheKey'];
const now = () => globalThis.performance?.now() ?? Date.now();
const bytes = value => new TextEncoder().encode(value).byteLength;
const count = value => Number.isSafeInteger(value) && value >= 0;
const between = (value, low, high) => count(value) && value >= low && value <= high;
const own = (value, key) => Object.hasOwn(value, key);
const fail = reason => { throw new Error(reason); };

// Read data properties only, never invoke getters/toJSON or inherit a schema.
function record(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (keys && !keys.includes(key)) || !own(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function array(value, limit = 10000) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  if (!between(length, 0, limit) || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const result = [];
  for (let index = 0; index < length; index++) {
    if (!own(descriptors[index] ?? {}, 'value')) return null;
    result.push(descriptors[index].value);
  }
  return result;
}

function jsonSnapshot(value, reason, state = { nodes: 0, ancestors: new Set() }, depth = 0) {
  if (++state.nodes > 10000 || depth > 32) fail(reason);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (value.length > MAX_BYTES) fail(reason); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(reason); return value; }
  if (typeof value !== 'object' || state.ancestors.has(value)) fail(reason);
  state.ancestors.add(value);
  const items = array(value);
  const fields = items ? null : record(value);
  if (!items && !fields) fail(reason);
  const result = items ? items.map(item => jsonSnapshot(item, reason, state, depth + 1))
    : Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, jsonSnapshot(item, reason, state, depth + 1)]));
  state.ancestors.delete(value);
  return Object.freeze(result);
}

function scalarMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

// Deliberately bounded JSON-schema subset, not a permissive general schema engine.
// All object fields are required, as OpenAI strict structured outputs require.
function validateSchema(schema, depth = 0, state = { nodes: 0 }) {
  if (++state.nodes > 256 || depth > 12 || !record(schema) || !TYPES.has(schema.type)) fail('INVALID_SCHEMA');
  const byType = {
    object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength', 'enum', 'const'], number: ['minimum', 'maximum', 'enum', 'const'],
    integer: ['minimum', 'maximum', 'enum', 'const'], boolean: ['enum', 'const'], null: ['enum', 'const'],
  };
  if (!record(schema, ['type', 'description', ...byType[schema.type]])
      || (own(schema, 'description') && (typeof schema.description !== 'string' || schema.description.length > 4000))) fail('INVALID_SCHEMA');
  if (schema.type === 'object') {
    const properties = record(schema.properties);
    const required = array(schema.required, 128);
    if (!properties || Object.keys(properties).length > 128 || !required || schema.additionalProperties !== false
        || required.length !== Object.keys(properties).length || new Set(required).size !== required.length
        || required.some(key => typeof key !== 'string' || !own(properties, key))) fail('INVALID_SCHEMA');
    for (const child of Object.values(properties)) validateSchema(child, depth + 1, state);
  } else if (schema.type === 'array') validateSchema(schema.items, depth + 1, state);
  for (const [minimum, maximum, integral] of [['minLength', 'maxLength', true], ['minItems', 'maxItems', true], ['minimum', 'maximum', false]]) {
    for (const key of [minimum, maximum]) if (own(schema, key)
        && !(integral ? between(schema[key], 0, MAX_BYTES) : typeof schema[key] === 'number' && Number.isFinite(schema[key]))) fail('INVALID_SCHEMA');
    if (own(schema, minimum) && own(schema, maximum) && schema[minimum] > schema[maximum]) fail('INVALID_SCHEMA');
  }
  if (own(schema, 'enum')) {
    const values = array(schema.enum, 256);
    if (!values?.length || values.some(value => !scalarMatches(value, schema.type)) || new Set(values).size !== values.length) fail('INVALID_SCHEMA');
  }
  if (own(schema, 'const') && (!scalarMatches(schema.const, schema.type) || (own(schema, 'enum') && !schema.enum.includes(schema.const)))) fail('INVALID_SCHEMA');
}

function matches(value, schema) {
  if (schema.type === 'object') {
    const fields = record(value);
    return fields !== null && Object.keys(fields).length === schema.required.length
      && schema.required.every(key => own(fields, key) && matches(fields[key], schema.properties[key]));
  }
  if (schema.type === 'array') {
    const values = array(value);
    return values !== null && (!own(schema, 'minItems') || values.length >= schema.minItems)
      && (!own(schema, 'maxItems') || values.length <= schema.maxItems) && values.every(item => matches(item, schema.items));
  }
  if (!scalarMatches(value, schema.type) || (own(schema, 'enum') && !schema.enum.includes(value)) || (own(schema, 'const') && value !== schema.const)) return false;
  if (schema.type === 'string') {
    const length = [...value].length; // JSON Schema lengths count Unicode code points.
    return (!own(schema, 'minLength') || length >= schema.minLength) && (!own(schema, 'maxLength') || length <= schema.maxLength);
  }
  return (!own(schema, 'minimum') || value >= schema.minimum) && (!own(schema, 'maximum') || value <= schema.maximum);
}

function providerSchema(schema) {
  // A scalar const is equivalent to a one-element enum in the provider's strict subset.
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'const').map(([key, value]) => [key,
    key === 'properties' ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, providerSchema(child)]))
      : key === 'items' ? providerSchema(value) : value]).concat(own(schema, 'const') ? [['enum', [schema.const]]] : []));
}

function prepare(request, options) {
  const fields = record(options, CONFIG_KEYS);
  if (!fields) fail('INVALID_CONFIGURATION');
  const config = { timeoutMs: 60000, maxOutputTokens: 2048, cacheMode: 'prefix', ...fields };
  if (!between(config.timeoutMs, 1, 120000) || !between(config.maxOutputTokens, 1, 16384) || !['prefix', 'off'].includes(config.cacheMode)
      || (own(config, 'cacheKey') && (typeof config.cacheKey !== 'string' || config.cacheKey.length < 1 || config.cacheKey.length > 256 || /[\u0000-\u001f\u007f]/.test(config.cacheKey)))) fail('INVALID_CONFIGURATION');
  const source = record(request, ['model', 'instructions', 'context', 'input', 'schema']);
  if (!source || typeof source.model !== 'string' || !own(MODELS, source.model) || typeof source.instructions !== 'string' || !source.instructions.trim()
      || typeof source.context !== 'string' || !own(source, 'input')) fail('INVALID_INPUT');
  const input = jsonSnapshot(source.input, 'INVALID_INPUT');
  const schema = jsonSnapshot(source.schema, 'INVALID_SCHEMA');
  validateSchema(schema);
  if (schema.type !== 'object') fail('INVALID_SCHEMA');
  const prefix = { type: 'text', text: source.context,
    ...(config.cacheMode === 'prefix' ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) };
  const body = JSON.stringify({ model: source.model,
    messages: [{ role: 'system', content: source.instructions }, { role: 'user', content: [prefix, { type: 'text', text: JSON.stringify(input) }] }],
    response_format: { type: 'json_schema', json_schema: { name: 'structured_task', strict: true, schema: providerSchema(schema) } },
    reasoning: { effort: MODELS[source.model].effort }, max_tokens: config.maxOutputTokens,
    tools: [], tool_choice: 'none', stream: false, service_tier: 'default',
    provider: { only: ['openai'], ignore: ['openai/flex', 'openai/fast'], allow_fallbacks: false, require_parameters: true },
    prompt_cache_options: { mode: 'explicit', ...(config.cacheMode === 'prefix' ? { ttl: '30m' } : {}) },
    ...(own(config, 'cacheKey') ? { prompt_cache_key: config.cacheKey } : {}),
  });
  const requestBytes = bytes(body);
  if (requestBytes > MAX_BYTES) fail('INPUT_TOO_LARGE');
  return { public: Object.freeze({ status: 'prepared', body, requestBytes, requestedModel: source.model }), schema, config };
}

/**
 * Pure preflight; accepts strict root-object schemas with nested object/array/scalar
 * types, scalar enum/const, descriptions and min/max bounds. Unknown keywords fail.
 * Cache keys are routing hints, not a guarantee of reuse across models or differing
 * content. The schema, instructions and context must form the same rendered prefix;
 * a breakpoint does not guarantee a hit or override the provider's minimum length.
 */
export function prepareStructuredRequest(request, options = {}) {
  try { return prepare(request, options).public; }
  catch (error) { fail(['INVALID_CONFIGURATION', 'INVALID_INPUT', 'INVALID_SCHEMA', 'INPUT_TOO_LARGE'].includes(error?.message) ? error.message : 'INVALID_INPUT'); }
}

const emptyUsage = () => ({ inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null });
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function metering(body) {
  const source = record(body?.usage);
  const input = record(source?.prompt_tokens_details);
  const output = record(source?.completion_tokens_details);
  const usage = emptyUsage();
  const raw = { inputTokens: source?.prompt_tokens, cachedInputTokens: input?.cached_tokens, cacheWriteTokens: input?.cache_write_tokens,
    outputTokens: source?.completion_tokens, reasoningTokens: output?.reasoning_tokens };
  for (const [key, value] of Object.entries(raw)) if (count(value)) usage[key] = value;
  if (usage.inputTokens !== null && (usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens) {
    usage.cachedInputTokens = null; usage.cacheWriteTokens = null;
  }
  if (usage.outputTokens !== null && usage.reasoningTokens > usage.outputTokens) usage.reasoningTokens = null;
  const reportedProviderUsd = amount(source?.cost);
  const details = record(source?.cost_details);
  return { usage, cost: { estimatedProviderUsd: null, reportedProviderUsd, knownUsageUsd: reportedProviderUsd,
    complete: reportedProviderUsd !== null, basis: 'provider_reported_credit_charge', cashChargeUsd: null,
    billingScope: 'openrouter_account_credits', upstreamInferenceCostUsd: amount(details?.upstream_inference_cost),
    isByok: typeof source?.is_byok === 'boolean' ? source.is_byok : null } };
}

function validateResponse(body, requestedModel, schema) {
  if (body.error != null) fail('PROVIDER_ERROR');
  if (!MODELS[requestedModel].observed.includes(body.model)) fail('UNEXPECTED_MODEL');
  if (!['OpenAI', 'openai'].includes(body.provider)) fail('UNEXPECTED_PROVIDER');
  if (body.service_tier != null && body.service_tier !== 'default') fail('UNEXPECTED_SERVICE_TIER');
  if ((body.tools != null && (!Array.isArray(body.tools) || body.tools.length)) || (body.tool_choice != null && body.tool_choice !== 'none')) fail('UNEXPECTED_TOOL');
  const choices = array(body.choices, 2);
  if (choices?.length !== 1) fail('INVALID_RESPONSE');
  const choice = record(choices[0]);
  const message = record(choice?.message);
  if (!choice || !message) fail('INVALID_RESPONSE');
  if (choice.error != null) fail('PROVIDER_ERROR');
  if ((message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length))
      || message.function_call != null || ['tool_calls', 'function_call'].includes(choice.finish_reason)) fail('UNEXPECTED_TOOL');
  if (message.refusal != null) fail('REFUSAL');
  if (choice.finish_reason !== 'stop') fail('INCOMPLETE_RESPONSE');
  if (message.role !== 'assistant' || typeof message.content !== 'string') fail('INVALID_RESPONSE');
  if (bytes(message.content) > MAX_BYTES) fail('INVALID_OUTPUT');
  let value;
  try { value = jsonSnapshot(JSON.parse(message.content), 'INVALID_OUTPUT'); } catch { fail('INVALID_OUTPUT'); }
  if (!matches(value, schema)) fail('INVALID_OUTPUT');
  return value;
}

/** One default-tier OpenAI route through OpenRouter, including fetch and JSON deadline. */
export async function runStructuredRequest(request, options = {}) {
  const started = now();
  let prepared; let reason = null; let requestedModel = null;
  try { const source = record(request); if (source && typeof source.model === 'string' && own(MODELS, source.model)) requestedModel = source.model; } catch { /* Fixed error below. */ }
  try { prepared = prepare(request, options); }
  catch (error) { reason = ['INVALID_CONFIGURATION', 'INVALID_INPUT', 'INVALID_SCHEMA', 'INPUT_TOO_LARGE'].includes(error?.message) ? error.message : 'INVALID_INPUT'; }
  let fetchImpl;
  if (!reason) {
    fetchImpl = own(prepared.config, 'fetchImpl') ? prepared.config.fetchImpl : globalThis.fetch;
    const key = prepared.config.apiKey;
    if (typeof fetchImpl !== 'function') reason = 'INVALID_CONFIGURATION';
    else if (typeof key !== 'string' || !key.trim()) reason = 'MISSING_API_KEY';
    else if (key.length > 4096 || /[\u0000-\u0020\u007f]/.test(key)) reason = 'INVALID_CONFIGURATION';
  }
  let requests = 0; let body = null; let httpStatus = null; let value = null;
  if (!reason) {
    const controller = new AbortController(); const deadline = now() + prepared.config.timeoutMs; let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ reason: 'TIMEOUT' }); }, prepared.config.timeoutMs); });
    requests = 1;
    const operation = (async () => {
      try {
        const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${prepared.config.apiKey}`, 'Content-Type': 'application/json' }, body: prepared.public.body });
        if (!controller.signal.aborted && now() < deadline && between(response.status, 100, 599)) httpStatus = response.status;
        try { return { body: await response.json(), reason: response.ok ? null : 'HTTP_ERROR' }; }
        catch { return { reason: response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR' }; }
      } catch { return { reason: controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED' }; }
    })();
    const result = await Promise.race([operation, timeout]); clearTimeout(timer);
    try { body = record(result.body); } catch { body = null; }
    reason = result.reason;
    // A synchronous JSON parser can hold the event loop past the timer. Its output
    // must not be accepted, but already-received billing evidence remains reportable.
    if (now() >= deadline) { controller.abort(); reason = 'TIMEOUT'; }
    if (!body && !reason) reason = 'INVALID_RESPONSE';
  }
  if (body && !reason) {
    try { value = validateResponse(body, requestedModel, prepared.schema); }
    catch (error) { reason = ['PROVIDER_ERROR', 'UNEXPECTED_MODEL', 'UNEXPECTED_PROVIDER', 'UNEXPECTED_SERVICE_TIER', 'UNEXPECTED_TOOL',
      'INVALID_RESPONSE', 'REFUSAL', 'INCOMPLETE_RESPONSE', 'INVALID_OUTPUT'].includes(error?.message) ? error.message : 'INVALID_RESPONSE'; }
  }
  let measured;
  try { measured = metering(body); } catch { measured = metering(null); }
  return { status: reason ? 'error' : 'ok', value: reason ? null : value, reason, requests, latencyMs: Math.max(0, now() - started), requestedModel,
    observedModel: OBSERVED_MODELS.has(body?.model) ? body.model : null,
    observedProvider: ['OpenAI', 'openai'].includes(body?.provider) ? 'OpenAI' : null,
    observedServiceTier: ['default', 'flex', 'fast', 'priority'].includes(body?.service_tier) ? body.service_tier : null,
    ...measured, httpStatus };
}
