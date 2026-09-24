import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareRouteRequest } from './router.mjs';
import { decideRouteBatch as defaultJev } from './router-batch.mjs';

const MODELS = { jev: 'jev-1.13.0', luna: 'openai/gpt-6-luna', astra: 'openai/gpt-6-astra' };
const OBSERVED_MODELS = { jev: [MODELS.jev], luna: [MODELS.luna, 'openai/gpt-6-luna-20260922'], astra: [MODELS.astra, 'openai/gpt-6-astra-20260903'] };
const TIERS = ['default', 'priority', 'fast', 'flex', 'scale', 'auto'];
const DEFAULTS = { strategy: 'adaptive', difficulty: 'routine', namespace: 'default', scope: 'default', ttlSeconds: 300,
  observationTtlSeconds: 300, maxCalls: 2, budgetUsd: 0.2, timeoutMs: 60000, maxOutputTokens: 1024,
  cacheMode: 'prefix', latencyWeightUsdPerSecond: 0.001, minConfidence: 0.75, minMargin: 0.1 };
const DEFAULT_ESTIMATES = { jev: { qualityEligible: true, expectedCostUsd: 0.005, expectedLatencyMs: 1000, cacheObservedAt: null },
  luna: { qualityEligible: true, expectedCostUsd: 0.01, expectedLatencyMs: 1500, cacheObservedAt: null },
  astra: { qualityEligible: true, expectedCostUsd: 0.1, expectedLatencyMs: 5000, cacheObservedAt: null } };
const ESCALATE = new Set(['NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE']);
const SAFE_REASONS = new Set([...ESCALATE, 'TIMEOUT', 'HTTP_ERROR', 'REQUEST_FAILED', 'INVALID_RESPONSE', 'INVALID_OUTPUT',
  'UNEXPECTED_MODEL', 'UNEXPECTED_PROVIDER', 'UNEXPECTED_SERVICE_TIER', 'UNEXPECTED_TOOL', 'REFUSAL', 'INCOMPLETE_RESPONSE',
  'PROVIDER_ERROR', 'CALL_BUDGET_EXHAUSTED', 'EXPECTED_BUDGET_EXHAUSTED', 'UNKNOWN_PRIOR_COST', 'INVALID_INPUT',
  'INVALID_CONFIGURATION', 'INPUT_TOO_LARGE', 'STATE_DIR_REQUIRED', 'STATE_LOCKED', 'STATE_INVALID', 'STATE_WRITE_FAILED',
  'UNCERTAIN_PRIOR_ATTEMPT', 'PRIOR_ATTEMPT_REQUIRES_REVIEW', 'MISSING_TYPESAFE_API_KEY', 'MISSING_OPENROUTER_API_KEY',
  'INVALID_CREDENTIALS', 'ENV_FILE_READ_ERROR', 'NO_ELIGIBLE_PROVIDER']);
const fail = reason => { throw new Error(reason); };
const amount = value => Number.isFinite(value) && value >= 0 ? value : null;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeReason = value => SAFE_REASONS.has(value) ? value : 'INVALID_RESPONSE';
const hasHostForecast = (options, provider) => ['expectedCostUsd', 'expectedLatencyMs', 'cacheObservedAt']
  .some(key => Object.hasOwn(options.config?.estimates?.[provider] ?? {}, key));
function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const copied = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) || !Object.hasOwn(field, 'value')) return null;
    copied[key] = field.value;
  }
  return copied;
}

function configuration(value = {}) {
  const source = record(value, [...Object.keys(DEFAULTS), 'estimates']);
  if (!source) fail('INVALID_CONFIGURATION');
  const config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, source[key] ?? fallback]));
  if (!['adaptive', ...Object.keys(MODELS)].includes(config.strategy) || !['routine', 'complex'].includes(config.difficulty)
      || !['prefix', 'off'].includes(config.cacheMode) || ![config.namespace, config.scope].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value))
      || !integer(config.ttlSeconds, 1, 86400) || !integer(config.observationTtlSeconds, 1, 86400) || !integer(config.maxCalls, 0, 2)
      || !integer(config.timeoutMs, 1, 60000) || !integer(config.maxOutputTokens, 16, 8192)
      || amount(config.budgetUsd) === null || amount(config.latencyWeightUsdPerSecond) === null
      || amount(config.minConfidence) === null || config.minConfidence < 0.75 || config.minConfidence > 1
      || amount(config.minMargin) === null || config.minMargin < 0.1 || config.minMargin > 1) fail('INVALID_CONFIGURATION');
  const observations = record(source.estimates ?? {}, Object.keys(MODELS));
  if (!observations) fail('INVALID_CONFIGURATION');
  config.estimates = {};
  for (const provider of Object.keys(MODELS)) {
    const fields = record(observations[provider] ?? {}, Object.keys(DEFAULT_ESTIMATES[provider]));
    if (!fields) fail('INVALID_CONFIGURATION');
    const estimate = { ...DEFAULT_ESTIMATES[provider], ...fields };
    if (typeof estimate.qualityEligible !== 'boolean' || amount(estimate.expectedCostUsd) === null || amount(estimate.expectedLatencyMs) === null
        || (estimate.cacheObservedAt !== null && !integer(estimate.cacheObservedAt, 0, Number.MAX_SAFE_INTEGER))) fail('INVALID_CONFIGURATION');
    config.estimates[provider] = estimate;
  }
  return config;
}

function preparation(input, options = {}) {
  if (!record(options, ['config', 'now'])) fail('INVALID_CONFIGURATION');
  const config = configuration(options.config), time = (options.now ?? Date.now)();
  if (!integer(time, 0, Number.MAX_SAFE_INTEGER)) fail('INVALID_CONFIGURATION');
  const routeConfig = { mode: 'shadow', model: MODELS.jev, maxCalls: 1, maxInputBytes: 60000, timeoutMs: config.timeoutMs,
    minConfidence: config.minConfidence, minMargin: config.minMargin };
  const prepared = prepareRouteRequest(input, routeConfig);
  if (prepared.status !== 'prepared') fail(prepared.reason);
  const policy = JSON.parse(prepared.body).questions.route;
  let provider = config.strategy === 'adaptive' ? (config.difficulty === 'complex' ? 'astra' : 'jev') : config.strategy;
  const warm = config.estimates.luna.cacheObservedAt;
  const recent = warm !== null && warm <= time && time - warm <= config.observationTtlSeconds * 1000;
  if (config.strategy === 'adaptive' && config.difficulty === 'routine') {
    const eligible = ['jev', ...(recent ? ['luna'] : [])].filter(name => config.estimates[name].qualityEligible);
    const score = name => config.estimates[name].expectedCostUsd + config.estimates[name].expectedLatencyMs / 1000 * config.latencyWeightUsdPerSecond;
    provider = eligible.sort((a, b) => score(a) - score(b))[0] ?? null;
  }
  const requiresObservation = provider === null && config.strategy === 'adaptive' && config.difficulty === 'routine'
    && config.estimates.luna.qualityEligible && config.cacheMode === 'prefix' && !hasHostForecast(options, 'luna');
  if ((!provider && !requiresObservation) || (provider && !config.estimates[provider].qualityEligible)) fail('NO_ELIGIBLE_PROVIDER');
  const fingerprint = hash({ schemaVersion: 1, snapshot: prepared.snapshot, policy, config, models: MODELS });
  return { config, time, prepared, policy, provider, fingerprint,
    selection: provider ? { provider, model: MODELS[provider], expectedCostUsd: config.estimates[provider].expectedCostUsd,
      expectedLatencyMs: config.estimates[provider].expectedLatencyMs, estimatesSource: hasHostForecast(options, provider) ? 'trusted_host' : 'configured_defaults',
      estimateBasis: hasHostForecast(options, provider) ? 'trusted_host_estimate' : 'configured_default_prior',
      providerCacheObservationRecent: provider === 'luna' && recent, providerCacheHitConfirmed: false } : null };
}

/** Pure exact-input preflight; no credential, state or network access. */
export function prepareAdaptiveRoute(input, options = {}) {
  try {
    const p = preparation(input, options);
    return { status: 'preflight', fingerprint: p.fingerprint, selection: p.selection, requiresObservation: p.selection === null,
      limits: { maxCalls: p.config.maxCalls, expectedCostBudgetUsd: p.config.budgetUsd, hardPrepaidCap: false,
        timeoutMs: p.config.timeoutMs, maxOutputTokens: p.config.maxOutputTokens },
      cache: { ttlSeconds: p.config.ttlSeconds, namespace: p.config.namespace, scope: p.config.scope, exactOnly: true } };
  } catch (error) { return { status: 'needs_host', reason: safeReason(error?.message) }; }
}

const total = values => values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
function costs(attempts) {
  const estimated = attempts.filter(item => item.provider === 'jev'), reported = attempts.filter(item => item.provider !== 'jev');
  return { estimatedProviderUsd: total(estimated.map(item => item.cost.estimatedProviderUsd)),
    reportedProviderUsd: total(reported.map(item => item.cost.reportedProviderUsd)),
    accountedProviderUsd: total(attempts.map(item => item.cost.complete ? item.cost.estimatedProviderUsd ?? item.cost.reportedProviderUsd : null)),
    complete: attempts.every(item => item.cost.complete), cashChargeUsd: null, mixedBases: estimated.length > 0 && reported.length > 0,
    scope: 'Estimated JEV usage plus OpenRouter account credits; excludes possible BYOK upstream charges and host costs.' };
}
function safeCost(raw, provider, calls) {
  const source = record(raw) ?? {}, isJev = provider === 'jev';
  const estimatedProviderUsd = isJev ? amount(source.estimatedJevUsd) : null;
  const reportedProviderUsd = isJev ? null : amount(source.reportedProviderUsd);
  return { estimatedProviderUsd: calls === 0 && isJev ? 0 : estimatedProviderUsd,
    reportedProviderUsd: calls === 0 && !isJev ? 0 : reportedProviderUsd,
    complete: calls === 0 || (source.complete === true && (isJev ? estimatedProviderUsd : reportedProviderUsd) !== null),
    basis: isJev ? 'provider_pricing_estimate' : 'provider_reported_credit_charge',
    billingScope: isJev ? 'typesafe_api_usage_estimate' : 'openrouter_account_credits',
    isByok: !isJev && typeof source.isByok === 'boolean' ? source.isByok : null,
    upstreamInferenceCostUsd: !isJev ? amount(source.upstreamInferenceCostUsd) : null, cashChargeUsd: null };
}
function usage(value) {
  const source = record(value) ?? {};
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens'].map(key =>
    [key, integer(source[key], 0, Number.MAX_SAFE_INTEGER) ? source[key] : null]));
}
function result(p, attempts = [], outcome = {}) {
  const cost = costs(attempts), requests = attempts.reduce((sum, item) => sum + item.requests, 0);
  return { status: 'needs_host', reason: null, routeId: null, requiresHostApproval: false, ...outcome,
    fingerprint: p?.fingerprint ?? null, selection: p?.selection ?? null, cacheHit: false, replayed: false,
    advisoryOnly: true, executionClaimed: false, requiresFreshHostValidation: true,
    latencyMs: attempts.reduce((sum, item) => sum + item.latencyMs, 0), requests, cost, attempts,
    decisionRequests: requests, decisionCost: cost,
    budget: { expectedCostBudgetUsd: p?.config.budgetUsd ?? null, hardPrepaidCap: false,
      actualOverExpectedBudget: cost.accountedProviderUsd === null ? null : cost.accountedProviderUsd > (p?.config.budgetUsd ?? Infinity) } };
}

async function bounded(path, maximum) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('STATE_INVALID');
  const handle = await open(path, 'r');
  try { const data = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < data.length) { const part = await handle.read(data, offset, data.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    if (offset > maximum) fail('STATE_INVALID'); return data.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}
async function readState(path) {
  let state;
  try { state = JSON.parse(await bounded(path, 4000000)); }
  catch (error) { if (error?.code === 'ENOENT') return { schemaVersion: 1, jobs: {}, observations: {}, jevObservations: {} }; fail('STATE_INVALID'); }
  if (!record(state, ['schemaVersion', 'jobs', 'observations', 'jevObservations']) || state.schemaVersion !== 1 || !record(state.jobs) || Object.keys(state.jobs).length > 5000) fail('STATE_INVALID');
  for (const [key, job] of Object.entries(state.jobs)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(job, ['state', 'updatedAt', 'result']) || !['pending', 'completed'].includes(job.state)
        || !integer(job.updatedAt, 0, Number.MAX_SAFE_INTEGER) || (job.state === 'completed' && (!record(job.result)
          || job.result.fingerprint !== key || !['selected', 'needs_host'].includes(job.result.status)
          || !Array.isArray(job.result.attempts) || job.result.attempts.length > 2 || !integer(job.result.requests, 0, 2)))) fail('STATE_INVALID');
    if (job.state !== 'completed') continue;
    for (const attempt of job.result.attempts) {
      if (!record(attempt, ['provider', 'requestedModel', 'observedModel', 'observedProvider', 'observedServiceTier', 'status', 'reason', 'routeId', 'requests', 'latencyMs', 'expectedCostUsd', 'usage', 'cost'])
          || !Object.hasOwn(MODELS, attempt.provider) || attempt.requestedModel !== MODELS[attempt.provider]
          || ![null, ...OBSERVED_MODELS[attempt.provider]].includes(attempt.observedModel)
          || ![null, 'OpenAI'].includes(attempt.observedProvider) || ![null, ...TIERS].includes(attempt.observedServiceTier)
          || !['selected', 'needs_host'].includes(attempt.status) || !(attempt.reason === null || SAFE_REASONS.has(attempt.reason))
          || !integer(attempt.requests, 0, 1) || amount(attempt.latencyMs) === null || amount(attempt.expectedCostUsd) === null
          || JSON.stringify(usage(attempt.usage)) !== JSON.stringify(attempt.usage)
          || JSON.stringify(safeCost({ ...attempt.cost, estimatedJevUsd: attempt.cost?.estimatedProviderUsd }, attempt.provider, attempt.requests)) !== JSON.stringify(attempt.cost)) fail('STATE_INVALID');
      if (attempt.status === 'selected') {
        if (attempt.reason !== null || attempt.requests !== 1 || !OBSERVED_MODELS[attempt.provider].includes(attempt.observedModel)
            || typeof attempt.routeId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(attempt.routeId)
            || attempt.routeId === 'NONE' || (attempt.provider !== 'jev' && attempt.observedProvider !== 'OpenAI')) fail('STATE_INVALID');
      } else if (attempt.routeId !== null || !SAFE_REASONS.has(attempt.reason)) fail('STATE_INVALID');
    }
    if (JSON.stringify(costs(job.result.attempts)) !== JSON.stringify(job.result.cost)
        || JSON.stringify(job.result.cost) !== JSON.stringify(job.result.decisionCost)
        || job.result.requests !== job.result.attempts.reduce((sum, attempt) => sum + attempt.requests, 0)
        || job.result.decisionRequests !== job.result.requests) fail('STATE_INVALID');
    const last = job.result.attempts.at(-1);
    if (!last || (job.result.status === 'selected' && (last.status !== 'selected' || job.result.reason !== null || job.result.routeId !== last.routeId))
        || (job.result.status === 'needs_host' && (last.status !== 'needs_host' || job.result.routeId !== null))) fail('STATE_INVALID');
    for (const attempt of job.result.attempts.slice(0, -1)) {
      if (attempt.status !== 'needs_host' || !ESCALATE.has(attempt.reason) || attempt.provider === 'astra') fail('STATE_INVALID');
    }
    if (job.result.attempts.length > 1 && last.provider !== 'astra') fail('STATE_INVALID');
    const selection = job.result.selection;
    if (!record(selection, ['provider', 'model', 'expectedCostUsd', 'expectedLatencyMs', 'estimatesSource', 'estimateBasis', 'providerCacheObservationRecent', 'providerCacheHitConfirmed'])
        || !Object.hasOwn(MODELS, selection.provider) || selection.model !== MODELS[selection.provider]
        || amount(selection.expectedCostUsd) === null || amount(selection.expectedLatencyMs) === null
        || !['trusted_host', 'configured_defaults', 'local_provider_observation'].includes(selection.estimatesSource)
        || typeof selection.providerCacheObservationRecent !== 'boolean' || selection.providerCacheHitConfirmed !== false) fail('STATE_INVALID');
    const expectedBasis = selection.estimatesSource === 'trusted_host' ? 'trusted_host_estimate'
      : selection.estimatesSource === 'configured_defaults' ? 'configured_default_prior'
        : selection.provider === 'jev' ? 'provider_pricing_estimate' : 'provider_reported_credit_charge';
    if (selection.estimateBasis !== undefined && selection.estimateBasis !== expectedBasis) fail('STATE_INVALID');
  }
  state.observations ??= {};
  if (!record(state.observations) || Object.keys(state.observations).length > 1000) fail('STATE_INVALID');
  for (const [key, value] of Object.entries(state.observations)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(value, ['observedAt', 'reportedProviderUsd', 'latencyMs', 'cachedInputTokens', 'inputBytes'])
        || !integer(value.observedAt, 0, Number.MAX_SAFE_INTEGER) || amount(value.reportedProviderUsd) === null || amount(value.latencyMs) === null
        || !integer(value.cachedInputTokens, 1, Number.MAX_SAFE_INTEGER) || !integer(value.inputBytes, 1, 100000)) fail('STATE_INVALID');
  }
  // Optional separate map preserves compatibility with existing Luna-only state.
  state.jevObservations ??= {};
  if (!record(state.jevObservations) || Object.keys(state.jevObservations).length > 1000) fail('STATE_INVALID');
  for (const [key, value] of Object.entries(state.jevObservations)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(value, ['observedAt', 'estimatedProviderUsd', 'basis', 'latencyMs', 'inputTokens', 'inputBytes'])
        || !integer(value.observedAt, 0, Number.MAX_SAFE_INTEGER) || amount(value.estimatedProviderUsd) === null
        || value.basis !== 'provider_pricing_estimate' || amount(value.latencyMs) === null
        || !integer(value.inputTokens, 0, Number.MAX_SAFE_INTEGER) || !integer(value.inputBytes, 1, 100000)) fail('STATE_INVALID');
  }
  return state;
}

const prefixKey = (p, provider = 'luna') => hash({ namespace: p.config.namespace, scope: p.config.scope, policy: p.policy, model: MODELS[provider],
  cacheMode: p.config.cacheMode, maxOutputTokens: p.config.maxOutputTokens });
const inputBytes = p => Buffer.byteLength(JSON.stringify(p.prepared.snapshot.task));
function applyObservation(p, state, options) {
  if (p.config.strategy !== 'adaptive' || p.config.difficulty !== 'routine') return;
  const fresh = observation => observation && observation.observedAt <= p.time
    && p.time - observation.observedAt <= p.config.observationTtlSeconds * 1000;
  const candidates = [];
  for (const provider of ['jev', 'luna']) {
    const estimate = p.config.estimates[provider], host = hasHostForecast(options, provider);
    if (!estimate.qualityEligible) continue;
    const observed = provider === 'jev' ? state.jevObservations[prefixKey(p, 'jev')]
      : p.config.cacheMode === 'prefix' ? state.observations[prefixKey(p)] : null;
    const observation = !host && fresh(observed) ? observed : null;
    const hostWarm = estimate.cacheObservedAt !== null && estimate.cacheObservedAt <= p.time
      && p.time - estimate.cacheObservedAt <= p.config.observationTtlSeconds * 1000;
    if (provider === 'luna' && !observation && !hostWarm) continue;
    const expectedCostUsd = observation ? (provider === 'jev' ? observation.estimatedProviderUsd : observation.reportedProviderUsd)
      * Math.max(1, inputBytes(p) / observation.inputBytes) : estimate.expectedCostUsd;
    if (amount(expectedCostUsd) === null) continue;
    candidates.push({ provider, model: MODELS[provider], expectedCostUsd,
      expectedLatencyMs: observation ? observation.latencyMs : estimate.expectedLatencyMs,
      estimatesSource: observation ? 'local_provider_observation' : host ? 'trusted_host' : 'configured_defaults',
      estimateBasis: observation ? provider === 'jev' ? 'provider_pricing_estimate' : 'provider_reported_credit_charge'
        : host ? 'trusted_host_estimate' : 'configured_default_prior',
      providerCacheObservationRecent: provider === 'luna' && (!!observation || hostWarm), providerCacheHitConfirmed: false });
  }
  const score = (cost, latency) => cost + latency / 1000 * p.config.latencyWeightUsdPerSecond;
  candidates.sort((a, b) => score(a.expectedCostUsd, a.expectedLatencyMs) - score(b.expectedCostUsd, b.expectedLatencyMs));
  if (!candidates.length) fail('NO_ELIGIBLE_PROVIDER');
  p.selection = candidates[0]; p.provider = p.selection.provider;
}
async function atomic(path, value) {
  const body = JSON.stringify(value); if (Buffer.byteLength(body) > 4000000) fail('STATE_WRITE_FAILED');
  const temporary = `${path}.${randomUUID()}.tmp`; let handle;
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null; await rename(temporary, path); }
  finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function keysFor(options, names) {
  let keys = record(options.apiKeys ?? {}, ['typesafe', 'openrouter']);
  if (!keys) fail('INVALID_CREDENTIALS');
  if (names.some(name => !keys[name]) && options.envFile !== undefined) {
    let env; try { env = parseEnv(await bounded(resolve(options.envFile), 65536)); } catch { fail('ENV_FILE_READ_ERROR'); }
    keys = { typesafe: keys.typesafe || env.TYPESAFE_API_KEY, openrouter: keys.openrouter || env.OPENROUTER_API_KEY };
  }
  for (const name of names) {
    if (keys[name] !== undefined && (typeof keys[name] !== 'string' || keys[name].length > 4096 || /[\r\n\u0000]/.test(keys[name]))) fail('INVALID_CREDENTIALS');
    if (!keys[name]?.trim()) fail(name === 'typesafe' ? 'MISSING_TYPESAFE_API_KEY' : 'MISSING_OPENROUTER_API_KEY');
  }
  return keys;
}

/** Advisory only. Durable pending reservations block automatic duplicate paid attempts. */
export async function runAdaptiveRoute(input, options = {}) {
  let p, lock, directory, state, statePath; const attempts = [];
  try {
    if (!record(options, ['config', 'stateDir', 'apiKeys', 'envFile', 'fetchImpl', 'runStructuredRequest', 'decideRouteBatch', 'now'])) fail('INVALID_CONFIGURATION');
    p = preparation(input, { config: options.config, now: options.now });
    if (typeof options.stateDir !== 'string' || !options.stateDir.trim()) fail('STATE_DIR_REQUIRED');
    directory = resolve(options.stateDir); await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STATE_INVALID');
    try { lock = await open(join(directory, '.adaptive-router.lock'), 'wx', 0o600); }
    catch (error) { if (error?.code === 'EEXIST') fail('STATE_LOCKED'); throw error; }
    statePath = join(directory, 'adaptive-state.json'); state = await readState(statePath);
    const prior = state.jobs[p.fingerprint];
    if (prior?.state === 'pending') fail('UNCERTAIN_PRIOR_ATTEMPT');
    if (prior?.state === 'completed') {
      if (prior.updatedAt > p.time) fail('STATE_INVALID');
      if (prior.result.status !== 'selected') return { ...result(p, [], { reason: 'PRIOR_ATTEMPT_REQUIRES_REVIEW' }), replayed: true,
        decisionRequests: prior.result.requests, decisionCost: prior.result.cost };
      if (prior.updatedAt <= p.time && p.time - prior.updatedAt < p.config.ttlSeconds * 1000) {
        const route = p.prepared.snapshot.routes.find(item => item.id === prior.result.routeId && item.available);
        if (!route) fail('STATE_INVALID');
        return { ...result(p, [], { status: 'selected', routeId: route.id, requiresHostApproval: route.requiresApproval }), cacheHit: true, replayed: true,
          selection: prior.result.selection, decisionRequests: prior.result.requests, decisionCost: prior.result.cost };
      }
    }
    applyObservation(p, state, options);
    if (!p.config.maxCalls) fail('CALL_BUDGET_EXHAUSTED');
    if (p.selection.expectedCostUsd > p.config.budgetUsd) fail('EXPECTED_BUDGET_EXHAUSTED');
    const mayEscalate = p.provider !== 'astra' && p.config.strategy === 'adaptive' && p.config.maxCalls > 1
      && p.config.estimates.astra.qualityEligible && p.selection.expectedCostUsd + p.config.estimates.astra.expectedCostUsd <= p.config.budgetUsd;
    const needed = [...new Set([p.provider === 'jev' ? 'typesafe' : 'openrouter', ...(mayEscalate ? ['openrouter'] : [])])];
    const transport = options.fetchImpl ?? globalThis.fetch;
    if (typeof transport !== 'function') fail('INVALID_CONFIGURATION');
    const jev = options.decideRouteBatch ?? defaultJev;
    let llm = options.runStructuredRequest, structured;
    if (p.provider !== 'jev' || mayEscalate) { structured = await import('./structured-llm.mjs'); llm ??= structured.runStructuredRequest; }
    const llmRequest = provider => ({ model: MODELS[provider], instructions: p.policy.instructions,
      context: JSON.stringify({ criteria: p.policy.criteria }), input: p.prepared.snapshot.task,
      schema: { type: 'object', properties: { routeId: { type: 'string', enum: [...p.prepared.eligibleRouteIds, 'NONE'] } }, required: ['routeId'], additionalProperties: false } });
    if (p.provider === 'jev') {
      const checked = await defaultJev([p.prepared.snapshot], { config: { ...p.prepared.config, mode: 'dry-run' } });
      if (checked.status !== 'dry_run') fail(checked.reason);
    }
    if (structured) for (const provider of [...(p.provider !== 'jev' ? [p.provider] : []), ...(mayEscalate ? ['astra'] : [])]) {
      structured.prepareStructuredRequest(llmRequest(provider), { timeoutMs: p.config.timeoutMs, maxOutputTokens: p.config.maxOutputTokens,
        cacheMode: p.config.cacheMode, cacheKey: hash([p.config.namespace, p.config.scope, p.policy, MODELS[provider]]) });
    }
    const keys = await keysFor(options, needed);
    // Reserve before the first dispatch, retaining pending if completion cannot be committed.
    state.jobs[p.fingerprint] = { state: 'pending', updatedAt: p.time }; await atomic(statePath, state);
    let provider = p.provider, outcome;
    for (;;) {
      let calls = 0, raw; const started = performance.now();
      const fetchImpl = async (url, request) => {
        if (calls >= 1 || attempts.reduce((sum, item) => sum + item.requests, 0) >= p.config.maxCalls) fail('CALL_BUDGET_EXHAUSTED');
        const endpoint = provider === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/v1/chat/completions';
        if (url !== endpoint || request?.method !== 'POST') fail('INVALID_RESPONSE');
        calls++; return transport(url, request);
      };
      try {
        raw = provider === 'jev' ? await jev([p.prepared.snapshot], { config: p.prepared.config, apiKey: keys.typesafe, fetchImpl })
          : await llm(llmRequest(provider), { apiKey: keys.openrouter, fetchImpl, timeoutMs: p.config.timeoutMs,
            maxOutputTokens: p.config.maxOutputTokens, cacheMode: p.config.cacheMode,
            cacheKey: hash([p.config.namespace, p.config.scope, p.policy, MODELS[provider]]) });
      } catch { raw = { status: 'error', reason: 'REQUEST_FAILED' }; }
      const decision = provider === 'jev' && raw?.status === 'decided' ? raw.decisions?.[0] : raw;
      const routeId = provider === 'jev' ? decision?.routeId : raw?.value?.routeId;
      const success = calls === 1 && (provider === 'jev' ? decision?.status === 'selected' && decision.model === MODELS.jev
        : raw?.status === 'ok' && OBSERVED_MODELS[provider].includes(raw.observedModel) && raw.observedProvider === 'OpenAI');
      const route = p.prepared.snapshot.routes.find(item => item.id === routeId && item.available);
      const reason = success && route ? null : routeId === 'NONE' && raw?.status === 'ok' ? 'NO_SAFE_ROUTE' : safeReason(decision?.reason);
      attempts.push({ provider, requestedModel: MODELS[provider], observedModel: OBSERVED_MODELS[provider].includes(raw?.observedModel) ? raw.observedModel : provider === 'jev' && decision?.model === MODELS.jev ? MODELS.jev : null,
        observedProvider: raw?.observedProvider === 'OpenAI' ? 'OpenAI' : null,
        observedServiceTier: TIERS.includes(raw?.observedServiceTier) ? raw.observedServiceTier : null,
        status: reason === null ? 'selected' : 'needs_host', reason, routeId: reason === null ? route.id : null,
        requests: calls, latencyMs: Math.max(0, performance.now() - started),
        expectedCostUsd: provider === p.provider ? p.selection.expectedCostUsd : p.config.estimates[provider].expectedCostUsd,
        usage: usage(provider === 'jev' ? raw?.cost : raw?.usage), cost: safeCost(raw?.cost, provider, calls) });
      outcome = reason === null ? { status: 'selected', routeId: route.id, requiresHostApproval: route.requiresApproval }
        : { reason };
      if (!(provider === p.provider && mayEscalate && ESCALATE.has(reason))) break;
      const actual = costs(attempts).accountedProviderUsd;
      if (actual === null) { outcome = { reason: 'UNKNOWN_PRIOR_COST' }; break; }
      if (actual + p.config.estimates.astra.expectedCostUsd > p.config.budgetUsd) { outcome = { reason: 'EXPECTED_BUDGET_EXHAUSTED' }; break; }
      // Keep the job pending across escalation; failure between calls requires host review.
      provider = 'astra';
    }
    const completed = result(p, attempts, outcome);
    const luna = attempts.find(attempt => attempt.provider === 'luna' && attempt.status === 'selected' && attempt.cost.complete
      && attempt.cost.isByok === false && attempt.usage.cachedInputTokens > 0);
    if (luna && p.config.cacheMode === 'prefix') state.observations[prefixKey(p)] = { observedAt: (options.now ?? Date.now)(),
      reportedProviderUsd: luna.cost.reportedProviderUsd, latencyMs: luna.latencyMs, cachedInputTokens: luna.usage.cachedInputTokens, inputBytes: inputBytes(p) };
    const jevObservation = attempts.find(attempt => attempt.provider === 'jev' && attempt.status === 'selected' && attempt.cost.complete
      && attempt.usage.inputTokens !== null);
    if (jevObservation) state.jevObservations[prefixKey(p, 'jev')] = { observedAt: (options.now ?? Date.now)(),
      estimatedProviderUsd: jevObservation.cost.estimatedProviderUsd, basis: 'provider_pricing_estimate',
      latencyMs: jevObservation.latencyMs, inputTokens: jevObservation.usage.inputTokens, inputBytes: inputBytes(p) };
    state.jobs[p.fingerprint] = { state: 'completed', updatedAt: (options.now ?? Date.now)(), result: completed };
    await atomic(statePath, state); return completed;
  } catch (error) { return result(p, attempts, { reason: SAFE_REASONS.has(error?.message) ? error.message : 'STATE_WRITE_FAILED' }); }
  finally { if (lock) { await lock.close().catch(() => {}); await unlink(join(directory, '.adaptive-router.lock')).catch(() => {}); } }
}
