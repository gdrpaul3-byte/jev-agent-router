// Standard globals only, so the same meter can run in the persistent CUA REPL.
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const INPUT_USD_PER_MILLION = 0.042;
/** Published TypeSafe rate verified 2026-09-24. Credits, taxes and host costs are separate. */
export function summarizeBilling(stats) {
  return { ...stats, currency: 'USD', inputUsdPerMillion: INPUT_USD_PER_MILLION,
    estimatedJevUsd: stats.inputTokens === null ? null : stats.inputTokens * INPUT_USD_PER_MILLION / 1000000,
    knownUsageUsd: stats.knownInputTokens === null ? null : stats.knownInputTokens * INPUT_USD_PER_MILLION / 1000000,
    complete: stats.inputTokens !== null && stats.pendingRequests === 0 && stats.pendingUsage === 0,
    cashChargeUsd: null, hostCostUsd: null,
    scope: 'TypeSafe direct API list-price estimate; excludes credits, taxes, and host inference',
    pricingSource: 'https://docs.typesafe.ai/models', pricingVerifiedOn: '2026-09-24' };
}
const now = () => globalThis.performance?.now() ?? Date.now();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const modelName = value => typeof value === 'string' && /^jev(?:-(?:latest|[0-9][A-Za-z0-9._-]{0,63}))?$/.test(value) ? value : null;
const safeSum = values => { const sum = values.reduce((total, value) => total + value, 0); return Number.isSafeInteger(sum) ? sum : null; };

function allowedEndpoint(input) {
  try {
    const value = typeof input === 'string' || input instanceof URL ? input
      : typeof Request !== 'undefined' && input instanceof Request ? input.url : null;
    return value !== null && new URL(value).href === ENDPOINT;
  } catch { return false; }
}
function requestMetrics(options) {
  let requestBytes = null, questionCount = null;
  try {
    const body = options?.body;
    if (typeof body === 'string') {
      requestBytes = new TextEncoder().encode(body).byteLength;
      if (requestBytes <= 1000000) {
        const parsed = JSON.parse(body);
        if (record(parsed?.questions)) questionCount = Object.keys(parsed.questions).length;
      }
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) requestBytes = body.byteLength;
    else if (typeof Blob !== 'undefined' && body instanceof Blob) requestBytes = body.size;
  } catch { /* Measurement failure does not alter the caller's request. */ }
  return { requestBytes: count(requestBytes), questionCount: count(questionCount) };
}

/**
 * Wrap one supplied fetch without retrying or consuming its response. records()/stats() are
 * sanitized snapshots; inputTokens/outputTokens are null if any attempted call lacks usage.
 * latencyMs measures fetch settlement (headers); usageLatencyMs includes background clone parsing.
 * Await flush only AFTER ending the timed trial. A timeout preserves unknown values and pending counts.
 */
export function createMeteredFetch({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('INVALID_METER_FETCH');
  const entries = [];
  const pending = new Set();
  const records = () => entries.map(entry => ({ ...entry }));
  const stats = () => {
    const knownInput = entries.filter(entry => entry.inputTokens !== null);
    const knownOutput = entries.filter(entry => entry.outputTokens !== null);
    const knownBytes = entries.filter(entry => entry.requestBytes !== null);
    const knownQuestions = entries.filter(entry => entry.questionCount !== null);
    return {
      calls: entries.length,
      pendingRequests: entries.filter(entry => entry.responsePending).length,
      pendingUsage: entries.filter(entry => entry.usagePending).length,
      errors: entries.filter(entry => entry.error !== null).length,
      inputTokens: knownInput.length === entries.length ? safeSum(knownInput.map(entry => entry.inputTokens)) : null,
      outputTokens: knownOutput.length === entries.length ? safeSum(knownOutput.map(entry => entry.outputTokens)) : null,
      knownInputTokens: safeSum(knownInput.map(entry => entry.inputTokens)),
      knownOutputTokens: safeSum(knownOutput.map(entry => entry.outputTokens)),
      inputUsageCalls: knownInput.length,
      outputUsageCalls: knownOutput.length,
      requestBytes: knownBytes.length === entries.length ? safeSum(knownBytes.map(entry => entry.requestBytes)) : null,
      knownRequestBytes: safeSum(knownBytes.map(entry => entry.requestBytes)),
      questionCount: knownQuestions.length === entries.length ? safeSum(knownQuestions.map(entry => entry.questionCount)) : null,
      lastLatencyMs: entries.findLast(entry => entry.latencyMs !== null)?.latencyMs ?? null,
    };
  };
  function trackUsage(response, entry, started) {
    let clone;
    try {
      if (typeof response?.clone !== 'function') return;
      clone = response.clone();
      if (typeof clone?.json !== 'function') return;
    } catch { return; }
    entry.usagePending = true;
    const task = Promise.resolve().then(() => clone.json()).then(body => {
      if (!record(body)) return;
      entry.model = modelName(body.model);
      if (record(body.usage)) {
        entry.inputTokens = count(body.usage.input_tokens);
        entry.outputTokens = count(body.usage.output_tokens);
      }
      entry.usageParsed = true;
    }).catch(() => { /* Raw provider data and parse errors never enter the records. */ }).finally(() => {
      entry.usagePending = false;
      entry.usageLatencyMs = Math.max(0, now() - started);
      pending.delete(task);
    });
    pending.add(task);
  }
  async function meteredFetch(input, options) {
    if (!allowedEndpoint(input)) throw new TypeError('METERED_FETCH_ENDPOINT_NOT_ALLOWED');
    const started = now();
    const entry = { index: entries.length + 1, model: null, httpStatus: null, latencyMs: null, usageLatencyMs: null,
      inputTokens: null, outputTokens: null, ...requestMetrics(options), responsePending: true,
      usagePending: false, usageParsed: false, error: null };
    entries.push(entry);
    try {
      const response = await fetchImpl(input, options);
      entry.latencyMs = Math.max(0, now() - started);
      entry.responsePending = false;
      try {
        if (Number.isSafeInteger(response?.status) && response.status >= 100 && response.status <= 599) entry.httpStatus = response.status;
        if (response?.ok === false || entry.httpStatus >= 400) entry.error = 'HTTP_ERROR';
      } catch { /* Preserve unusual injected response semantics. */ }
      trackUsage(response, entry, started);
      return response;
    } catch (error) {
      entry.latencyMs = Math.max(0, now() - started);
      entry.responsePending = false;
      entry.error = 'TRANSPORT_FAILED';
      throw error; // Caller retains normal fetch behavior; only the meter's stored error is sanitized.
    }
  }
  async function flush({ timeoutMs = 2000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new TypeError('INVALID_METER_FLUSH_TIMEOUT');
    const deadline = now() + timeoutMs;
    // Headers may still be pending after the caller's own deadline. Waiting is bounded and never retries.
    while (entries.some(entry => entry.responsePending || entry.usagePending) && now() < deadline) {
      const remaining = Math.max(0, deadline - now());
      let timer;
      try {
        await Promise.race([
          new Promise(resolve => { timer = setTimeout(resolve, Math.min(remaining, 20)); }),
          ...(pending.size ? [Promise.allSettled([...pending])] : []),
        ]);
      } finally { clearTimeout(timer); }
    }
    return stats();
  }
  return Object.freeze({ fetchImpl: meteredFetch, stats, records, flush });
}
