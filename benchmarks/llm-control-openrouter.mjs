// OpenRouter transport control: includes gateway overhead, not a direct OpenAI benchmark.
// Reuse the existing packet/schema/decision/deadline validation through a local
// chat-to-Responses projection. The injected transport sends only ONE OpenRouter POST.
import { prepareOpenAiControlRequest, runOpenAiControl } from './llm-control-openai.mjs';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-6-luna';
// Verified public /api/v1/models/openai/gpt-6-luna/endpoints, 2026-09-24.
const OBSERVED_MODELS = new Set([MODEL, 'openai/gpt-6-luna-20260922']);
const NUMERIC_CODES = new Set(['400', '401', '402', '403', '408', '413', '422', '429', '500', '502', '503', '504']);
const CONFIG_KEYS = ['model', 'timeoutMs', 'maxOutputTokens'];
const COST_SOURCE = 'https://openrouter.ai/docs/cookbook/administration/usage-accounting';
const now = () => globalThis.performance?.now() ?? Date.now();
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function directConfig(options) {
  const fields = record(options, CONFIG_KEYS);
  if (!fields || (Object.hasOwn(fields, 'model') && fields.model !== MODEL)) throw new Error('INVALID_CONFIGURATION');
  return { ...fields, model: 'gpt-6-luna' };
}

/** Pure preflight with the same task data, policy and JSON schema as the direct control. */
export function prepareOpenRouterControlRequest(packet, options = {}) {
  let config;
  try { config = directConfig(options); } catch { throw new Error('INVALID_CONFIGURATION'); }
  const direct = JSON.parse(prepareOpenAiControlRequest(packet, config).body);
  const body = JSON.stringify({
    model: MODEL, messages: [{ role: 'system', content: direct.instructions }, ...direct.input],
    response_format: { type: 'json_schema', json_schema: { name: direct.text.format.name,
      strict: direct.text.format.strict, schema: direct.text.format.schema } },
    tools: [], tool_choice: 'none', stream: false, service_tier: 'default',
    reasoning: { effort: 'none' }, max_tokens: direct.max_output_tokens,
    provider: { only: ['openai'], ignore: ['openai/flex', 'openai/fast'], allow_fallbacks: false, require_parameters: true },
  });
  const requestBytes = new TextEncoder().encode(body).byteLength;
  if (requestBytes > 100000) throw new Error('INPUT_TOO_LARGE');
  return Object.freeze({ status: 'prepared', body, requestBytes, requestedModel: MODEL });
}

const emptyEvidence = () => ({ observedModel: null, observedProvider: null, observedServiceTier: null, errorCode: null,
  reportedProviderUsd: null, upstreamInferenceCostUsd: null, isByok: null, reason: null });

function projectReply(value) {
  const evidence = emptyEvidence();
  const body = record(value);
  if (!body) return { response: {}, evidence: { ...evidence, reason: 'INVALID_RESPONSE' } };
  if (OBSERVED_MODELS.has(body.model)) evidence.observedModel = body.model;
  if (body.provider === 'OpenAI' || body.provider === 'openai') evidence.observedProvider = 'OpenAI';
  if (['default', 'flex', 'fast', 'priority'].includes(body.service_tier)) evidence.observedServiceTier = body.service_tier;
  const usage = record(body.usage);
  const input = record(usage?.prompt_tokens_details);
  const output = record(usage?.completion_tokens_details);
  const details = record(usage?.cost_details);
  evidence.reportedProviderUsd = amount(usage?.cost);
  evidence.upstreamInferenceCostUsd = amount(details?.upstream_inference_cost);
  evidence.isByok = typeof usage?.is_byok === 'boolean' ? usage.is_byok : null;
  const error = record(body.error);
  const code = typeof error?.code === 'number' || typeof error?.code === 'string' ? String(error.code) : null;
  if (NUMERIC_CODES.has(code)) evidence.errorCode = code;
  const response = { model: evidence.observedModel ? 'gpt-6-luna' : null, status: 'completed',
    error: error ? { code: error.code, type: error.type } : null, tools: [], tool_choice: 'none',
    usage: { input_tokens: usage?.prompt_tokens, input_tokens_details: { cached_tokens: input?.cached_tokens, cache_write_tokens: input?.cache_write_tokens },
      output_tokens: usage?.completion_tokens, output_tokens_details: { reasoning_tokens: output?.reasoning_tokens },
      ...(Object.hasOwn(usage ?? {}, 'total_tokens') ? { total_tokens: usage.total_tokens } : {}) }, output: [],
  };
  if (body.error !== undefined && body.error !== null) evidence.reason = 'PROVIDER_ERROR';
  else if (!evidence.observedModel) evidence.reason = 'UNEXPECTED_MODEL';
  else if (!evidence.observedProvider) evidence.reason = 'UNEXPECTED_PROVIDER';
  else if (!Array.isArray(body.choices) || body.choices.length !== 1) evidence.reason = 'INVALID_RESPONSE';
  else {
    const choice = record(body.choices[0]);
    const message = record(choice?.message);
    if (!choice || !message) evidence.reason = 'INVALID_RESPONSE';
    else if ((message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
        || message.function_call != null || ['tool_calls', 'function_call'].includes(choice.finish_reason)) evidence.reason = 'UNEXPECTED_TOOL';
    else if (message.refusal != null) evidence.reason = 'REFUSAL';
    else if (choice.finish_reason !== 'stop') evidence.reason = 'INCOMPLETE_RESPONSE';
    else if (message.role !== 'assistant' || typeof message.content !== 'string') evidence.reason = 'INVALID_RESPONSE';
    else response.output = [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: message.content }] }];
  }
  return { response, evidence };
}

function reportedCost(evidence) {
  // OpenRouter account credit charge and upstream inference cost overlap. Never add
  // them or apply the direct OpenAI token-rate estimate to an OpenRouter response.
  return { estimatedProviderUsd: null, reportedProviderUsd: evidence.reportedProviderUsd,
    upstreamInferenceCostUsd: evidence.upstreamInferenceCostUsd,
    knownUsageUsd: evidence.reportedProviderUsd, cashChargeUsd: null, complete: evidence.reportedProviderUsd !== null,
    basis: 'provider_reported_credit_charge', billingScope: 'openrouter_account_credits', isByok: evidence.isByok,
    pricingSource: COST_SOURCE, pricingVerifiedOn: '2026-09-24' };
}

/** Exactly one routed request, no generation lookup, retry or fallback credential. */
export async function runOpenRouterControl(packet, options = {}) {
  const started = now();
  let fields; let config; let prepared; let preflightReason = null;
  try {
    fields = record(options, [...CONFIG_KEYS, 'apiKey', 'fetchImpl']);
    if (!fields) throw new Error('INVALID_CONFIGURATION');
    config = Object.fromEntries(CONFIG_KEYS.filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key]]));
    prepared = prepareOpenRouterControlRequest(packet, config);
  } catch (error) {
    preflightReason = ['INVALID_INPUT', 'INPUT_TOO_LARGE'].includes(error?.message) ? error.message : 'INVALID_CONFIGURATION';
  }
  let evidence = emptyEvidence();
  let result;
  if (preflightReason) {
    // Shared safe result construction validates packet IDs without sending anything.
    result = await runOpenAiControl(packet, { apiKey: '' });
    result.decisions = result.decisions.map(item => ({ ...item, reason: preflightReason }));
  } else {
    const fetchImpl = Object.hasOwn(fields, 'fetchImpl') ? fields.fetchImpl : globalThis.fetch;
    const routedFetch = async (_unusedDirectUrl, init) => {
      const response = await fetchImpl(ENDPOINT, { ...init, body: prepared.body });
      return { ok: response.ok, status: response.status, json: async () => {
        const projected = projectReply(await response.json());
        if (!init.signal.aborted) evidence = projected.evidence;
        return projected.response;
      } };
    };
    result = await runOpenAiControl(packet, { ...directConfig(config), apiKey: fields.apiKey,
      fetchImpl: typeof fetchImpl === 'function' ? routedFetch : fetchImpl });
  }
  const transportFailed = result.decisions.some(item => ['TIMEOUT', 'REQUEST_FAILED'].includes(item.reason));
  if (transportFailed) evidence = emptyEvidence();
  // HTTP/transport failures have priority; route validation never turns them into NONE.
  if (result.requests && evidence.reason && result.httpStatus >= 200 && result.httpStatus < 300 && !transportFailed)
    result.decisions = result.decisions.map(item => ({ id: item.id, outcome: 'error', routeId: null, requiresHostApproval: null, reason: evidence.reason }));
  return { ...result, requestedModel: MODEL, observedModel: evidence.observedModel, observedProvider: evidence.observedProvider,
    observedServiceTier: evidence.observedServiceTier, providerErrorCode: evidence.errorCode ?? result.providerErrorCode,
    wallLatencyMs: Math.max(0, now() - started), cost: reportedCost(evidence) };
}
