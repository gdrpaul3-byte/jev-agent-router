// Local dispatch guard. Reservations are conservative estimates, not prepaid invoice caps.
const ORIGIN = 'https://openrouter.ai/api/v1/chat/completions';
const JEV = 'https://api.typesafe.ai/v1/systemone';
const RATES = Object.freeze({ 'openai/gpt-6-astra': [12.5, 50], 'openai/gpt-6-luna': [0.125, 0.5], 'jev-1.13.0': [0.042, 0] });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = code => { throw new Error(code); };
const copy = value => structuredClone(value);

export function createInferenceBudget({ fetchImpl = globalThis.fetch, budgetUsd = 5, maxRequests = 80 } = {}) {
  if (typeof fetchImpl !== 'function' || !finite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) fail('INVALID_BUDGET');
  const entries = [];
  let blockedReason = null;
  const records = () => copy(entries);
  const summary = () => {
    const complete = entries.every(row => row.costComplete);
    const estimated = entries.reduce((sum, row) => sum + (row.estimatedProviderUsd ?? 0), 0);
    const reported = entries.reduce((sum, row) => sum + (row.reportedProviderUsd ?? 0), 0);
    return { requests: entries.length, maxRequests, budgetUsd, hardPrepaidCap: false,
      accountedProviderUsd: complete ? estimated + reported : null, knownUsageUsd: estimated + reported,
      estimatedProviderUsd: estimated, reportedProviderUsd: reported, complete, blockedReason,
      cashChargeUsd: null, pricingVerifiedOn: '2026-09-24',
      scope: 'OpenRouter reported credit charge plus JEV input list-price estimate; excludes funding fees, tax and host inference' };
  };
  async function guardedFetch(endpoint, init) {
    const address = typeof endpoint === 'string' ? endpoint : endpoint instanceof URL ? endpoint.href : '';
    if (![ORIGIN, JEV].includes(address)) fail('ENDPOINT_NOT_ALLOWED');
    let request;
    const requestBytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0;
    try { request = JSON.parse(init?.body); } catch { fail('INVALID_BUDGET_REQUEST'); }
    if (init?.method !== 'POST' || requestBytes < 1 || requestBytes > 100000 || !Object.hasOwn(RATES, request?.model)
        || (address === JEV) !== (request.model === 'jev-1.13.0')
        || (address === ORIGIN && (!Number.isInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > 16384))) fail('INVALID_BUDGET_REQUEST');
    if (init?.signal?.aborted) fail('REQUEST_ABORTED');
    if (blockedReason === 'BYOK_SCOPE_UNSUPPORTED' || blockedReason === 'ACTUAL_COST_EXCEEDED_BUDGET') fail(blockedReason);
    if (entries.some(row => !row.costComplete)) { blockedReason = 'UNACCOUNTED_REQUEST'; fail(blockedReason); }
    if (entries.length >= maxRequests) { blockedReason = 'CALL_BUDGET_EXHAUSTED'; fail(blockedReason); }
    const [inputRate, outputRate] = RATES[request.model];
    // UTF-8 bytes overcount normal input tokens; an extra 8K allowance covers hidden/system overhead.
    // Actual returned usage/cost is authoritative and can stop the run even below the reservation.
    const reservedUsd = ((requestBytes + 8192) * inputRate + (request.max_tokens ?? 0) * outputRate) / 1000000;
    if (summary().knownUsageUsd + reservedUsd > budgetUsd) { blockedReason = 'COST_BUDGET_EXHAUSTED'; fail(blockedReason); }
    const row = { index: entries.length + 1, model: request.model, requestBytes, reservedUsd,
      estimatedProviderUsd: null, reportedProviderUsd: null, upstreamInferenceCostUsd: null, isByok: null,
      costComplete: false, httpStatus: null,
      latencyMs: null, error: null };
    entries.push(row); // Synchronous reservation prevents concurrent overspend.
    const started = performance.now();
    let abortListener;
    const aborted = new Promise((_, reject) => {
      if (init.signal) { abortListener = () => reject(new Error('ABORTED')); init.signal.addEventListener('abort', abortListener, { once: true }); }
    });
    try {
      const response = await Promise.race([Promise.resolve().then(() => fetchImpl(endpoint, init)), aborted]);
      if (!response || typeof response.clone !== 'function') fail('INVALID_RESPONSE');
      row.httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      let body = null;
      try { body = await Promise.race([response.clone().json(), aborted]); } catch { if (init.signal?.aborted) throw new Error('ABORTED'); }
      if (init.signal?.aborted) throw new Error('ABORTED');
      if (address === ORIGIN) {
        if (finite(body?.usage?.cost)) row.reportedProviderUsd = body.usage.cost;
        if (finite(body?.usage?.cost_details?.upstream_inference_cost)) row.upstreamInferenceCostUsd = body.usage.cost_details.upstream_inference_cost;
        if (typeof body?.usage?.is_byok === 'boolean') row.isByok = body.usage.is_byok;
      }
      else if (address === JEV && body?.model === 'jev-1.13.0' && Number.isSafeInteger(body?.usage?.input_tokens) && body.usage.input_tokens >= 0)
        row.estimatedProviderUsd = body.usage.input_tokens * 0.042 / 1000000;
      row.costComplete = row.reportedProviderUsd !== null || row.estimatedProviderUsd !== null;
      if (!response.ok) row.error = 'HTTP_ERROR';
      if (row.isByok === true) blockedReason = 'BYOK_SCOPE_UNSUPPORTED';
      else if (!row.costComplete) blockedReason = 'UNACCOUNTED_REQUEST';
      else if (summary().knownUsageUsd > budgetUsd) blockedReason = 'ACTUAL_COST_EXCEEDED_BUDGET';
      return response;
    } catch {
      row.error = 'TRANSPORT_FAILED'; blockedReason = 'UNACCOUNTED_REQUEST'; fail('TRANSPORT_FAILED');
    } finally {
      row.latencyMs = Math.max(0, performance.now() - started);
      if (abortListener) init.signal.removeEventListener('abort', abortListener);
    }
  }
  return Object.freeze({ fetchImpl: guardedFetch, summary, records });
}
