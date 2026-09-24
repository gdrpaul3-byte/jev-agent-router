#!/usr/bin/env node
import { open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

const MODEL = 'gpt-6-luna';
const PROVIDERS = Object.freeze({
  openai: { model: MODEL, prepare: 'prepareOpenAiControlRequest', run: 'runOpenAiControl', envKey: 'OPENAI_API_KEY' },
  openrouter: { model: 'openai/gpt-6-luna', prepare: 'prepareOpenRouterControlRequest', run: 'runOpenRouterControl', envKey: 'OPENROUTER_API_KEY' },
});
const LIMITS = Object.freeze({ timeoutMs: 60000, maxOutputTokens: 2048, maxRequests: 4, maxCases: 12, maxFileBytes: 1000000 });
const DEPENDENCIES = ['prepareComparisonCases', 'prepareJevControlRequest', 'prepareOpenAiControlRequest', 'prepareOpenRouterControlRequest', 'runJevControl', 'runOpenAiControl', 'runOpenRouterControl', 'fetchImpl'];
const ABSTENTIONS = new Set(['NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE']);
const REASONS = new Set([...ABSTENTIONS, 'INVALID_INPUT', 'INPUT_TOO_LARGE', 'INVALID_CONFIGURATION', 'MISSING_API_KEY',
  'REQUEST_FAILED', 'TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE', 'UNEXPECTED_MODEL', 'UNEXPECTED_TOOL', 'REFUSAL',
  'INCOMPLETE_RESPONSE', 'PROVIDER_ERROR', 'MISSING_DECISION', 'INVALID_CHOICE', 'INVALID_ADAPTER_RESULT',
  'EVALUATION_ARM_FAILED', 'CALL_BUDGET_EXHAUSTED', 'INVALID_COMPARISON_PACKET', 'UNEXPECTED_PROVIDER']);
const PRICE_URLS = new Set(['https://docs.typesafe.ai/models', 'https://developers.openai.com/api/docs/pricing',
  'https://developers.openai.com/api/docs/pricing/', 'https://platform.openai.com/docs/pricing', 'https://openai.com/api/pricing/',
  'https://openrouter.ai/docs/cookbook/administration/usage-accounting']);
const PROVIDER_ERROR_CODES = new Set(['invalid_api_key', 'insufficient_quota', 'model_not_found', 'invalid_json_schema',
  'rate_limit_exceeded', 'context_length_exceeded', 'billing_hard_limit_reached', 'unsupported_parameter',
  '400', '401', '402', '403', '408', '413', '422', '429', '500', '502', '503', '504']);
const PROVIDER_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error',
  'rate_limit_error', 'insufficient_quota', 'server_error']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = reason => { throw new Error(reason); };
const stop = reason => ({ exitCode: 2, result: { status: 'needs_host', reason } });
const now = () => performance.now();
const sum = values => values.some(value => value === null) ? null : values.reduce((total, value) => total + value, 0);
const safeReason = value => REASONS.has(value) ? value : 'UNKNOWN_REASON';
const safeModel = value => typeof value === 'string'
  && /^(?:jev-(?:latest|[0-9]+\.[0-9]+(?:\.[0-9]+)?)|gpt-6-luna(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?|openai\/gpt-6-luna(?:-20260922)?)$/.test(value) ? value : null;

async function resolveDependencies(options, runners = false) {
  const provider = options.provider ?? 'openai', selected = PROVIDERS[provider];
  const needed = ['prepareComparisonCases', 'prepareJevControlRequest', selected.prepare,
    ...(runners ? ['runJevControl', selected.run] : [])];
  const resolved = {};
  let jev, control;
  for (const name of needed) {
    if (options[name] !== undefined) resolved[name] = options[name];
    else if (['prepareComparisonCases', 'prepareJevControlRequest', 'runJevControl'].includes(name)) {
      jev ??= await import('./llm-control-cases.mjs'); resolved[name] = jev[name];
    } else {
      control ??= provider === 'openrouter' ? await import('./llm-control-openrouter.mjs') : await import('./llm-control-openai.mjs');
      resolved[name] = control[name];
    }
    if (typeof resolved[name] !== 'function') fail('INVALID_EVALUATION_OPTIONS');
  }
  resolved.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof resolved.fetchImpl !== 'function') fail('INVALID_EVALUATION_OPTIONS');
  return resolved;
}

function validateSettings(options, additional = []) {
  if (!known(options, ['rounds', 'model', 'provider', ...DEPENDENCIES, ...additional])) fail('INVALID_EVALUATION_OPTIONS');
  const provider = options.provider ?? 'openai';
  if (!Object.hasOwn(PROVIDERS, provider)) fail('INVALID_EVALUATION_OPTIONS');
  const rounds = options.rounds ?? 2, model = options.model ?? PROVIDERS[provider].model;
  if (![1, 2].includes(rounds) || model !== PROVIDERS[provider].model) fail('INVALID_EVALUATION_OPTIONS');
  return { rounds, model, provider };
}

async function prepare(fixtureOrCases, options, deps) {
  if (!Array.isArray(fixtureOrCases) && (!known(fixtureOrCases, ['schemaVersion', 'synthetic', 'language', 'description', 'cases'])
      || fixtureOrCases.schemaVersion !== 1 || fixtureOrCases.synthetic !== true)) fail('INVALID_EVALUATION_CASES');
  const prepared = deps.prepareComparisonCases(fixtureOrCases);
  if (!record(prepared) || !record(prepared.packet) || !Array.isArray(prepared.packet.tasks)
      || prepared.packet.tasks.length < 1 || prepared.packet.tasks.length > LIMITS.maxCases
      || !Array.isArray(prepared.scoring) || prepared.scoring.length !== prepared.packet.tasks.length
      || !hash(prepared.datasetSha256) || !hash(prepared.packetSha256)) fail('INVALID_EVALUATION_CASES');
  const ids = new Set();
  for (const [index, row] of prepared.scoring.entries()) {
    if (!id(row.originalCaseId) || row.opaqueId !== `t${index}` || prepared.packet.tasks[index]?.id !== row.opaqueId || ids.has(row.originalCaseId)) fail('INVALID_EVALUATION_CASES');
    ids.add(row.originalCaseId);
  }
  // Real preflight adapters validate their complete wire payloads before credentials.
  const jev = await deps.prepareJevControlRequest(structuredClone(prepared.packet));
  const control = await deps[PROVIDERS[options.provider].prepare](structuredClone(prepared.packet), {
    model: options.model, timeoutMs: LIMITS.timeoutMs, maxOutputTokens: LIMITS.maxOutputTokens,
  });
  if (jev?.status !== 'prepared' || control?.status !== 'prepared' || count(jev.requestBytes) === null || count(control.requestBytes) === null) fail('INVALID_EVALUATION_CASES');
  return { prepared, requests: { jev: jev.requestBytes, [options.provider]: control.requestBytes } };
}

/** Offline request preparation. Neither credentials nor paid adapters are consulted. */
export async function preflightLlmControl(fixtureOrCases, options = {}) {
  const settings = validateSettings(options), deps = await resolveDependencies(options);
  const { prepared, requests } = await prepare(fixtureOrCases, settings, deps);
  return { status: 'preflight', provider: settings.provider, synthetic: Array.isArray(fixtureOrCases) ? null : true, caseCount: prepared.scoring.length, rounds: settings.rounds,
    plannedRequests: settings.rounds * 2, models: { jev: 'jev-1.13.0', [settings.provider]: settings.model },
    limits: { ...LIMITS }, requestBytes: requests, datasetSha256: prepared.datasetSha256, packetSha256: prepared.packetSha256 };
}

function credentials(value, provider) {
  if (!known(value, ['typesafe', provider])) fail('INVALID_CREDENTIALS');
  for (const key of ['typesafe', provider]) if (value[key] !== undefined && (typeof value[key] !== 'string'
      || value[key].length > 4096 || /[\r\n\u0000]/.test(value[key]))) fail('INVALID_CREDENTIALS');
  if (!value.typesafe?.trim()) fail('MISSING_TYPESAFE_API_KEY');
  if (!value[provider]?.trim()) fail(`MISSING_${PROVIDERS[provider].envKey}`);
  return { typesafe: value.typesafe.trim(), [provider]: value[provider].trim() };
}

function sanitizeUsage(value) {
  const source = record(value) ? value : {};
  return Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'].map(key => [key, count(source[key])]));
}

function sanitizeCost(value, name) {
  const source = record(value) ? value : {};
  const reported = name === 'openrouter';
  const estimatedProviderUsd = reported ? null : finite(source.estimatedProviderUsd);
  const reportedProviderUsd = reported ? finite(source.reportedProviderUsd) : null;
  return { estimatedProviderUsd, reportedProviderUsd,
    upstreamInferenceCostUsd: reported ? finite(source.upstreamInferenceCostUsd) : null,
    isByok: reported && typeof source.isByok === 'boolean' ? source.isByok : null,
    knownUsageUsd: reported ? reportedProviderUsd : finite(source.knownUsageUsd), cashChargeUsd: null,
    complete: source.complete === true && (reported ? reportedProviderUsd : estimatedProviderUsd) !== null,
    basis: reported ? 'provider_reported_credit_charge' : 'provider_pricing_estimate',
    billingScope: reported ? 'openrouter_account_credits' : 'provider_api_usage_estimate',
    pricingSource: PRICE_URLS.has(source.pricingSource) ? source.pricingSource : null,
    pricingVerifiedOn: typeof source.pricingVerifiedOn === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(source.pricingVerifiedOn) ? source.pricingVerifiedOn : null };
}

function sanitizeRow(raw, item, task) {
  let outcome = 'error', routeId = null, requiresHostApproval = null, reason = 'INVALID_ADAPTER_RESULT';
  if (record(raw) && raw.outcome === 'accepted' && typeof raw.requiresHostApproval === 'boolean'
      && task.routes.some(route => route.id === raw.routeId)) {
    outcome = 'accepted'; routeId = raw.routeId; requiresHostApproval = raw.requiresHostApproval; reason = null;
  } else if (record(raw) && raw.outcome === 'abstained' && ABSTENTIONS.has(raw.reason) && raw.routeId === null && raw.requiresHostApproval === null) {
    outcome = 'abstained'; reason = raw.reason;
  } else if (record(raw) && raw.outcome === 'error') reason = safeReason(raw.reason);
  const expected = item.expected.needsHost === true ? { needsHost: true }
    : { routeId: item.expected.routeId, requiresHostApproval: item.expected.requiresHostApproval };
  const correct = expected.needsHost ? outcome === 'abstained'
    : outcome === 'accepted' && routeId === expected.routeId && requiresHostApproval === expected.requiresHostApproval;
  return { id: item.originalCaseId, expected, outcome, routeId, requiresHostApproval, reason, correct };
}

function metrics(rows) {
  const routing = rows.filter(row => !row.expected.needsHost), accepted = routing.filter(row => row.outcome === 'accepted');
  const host = rows.filter(row => row.expected.needsHost), correct = accepted.filter(row => row.correct).length;
  const hostCorrect = host.filter(row => row.correct).length;
  return {
    routing: { expected: routing.length, accepted: accepted.length, correct,
      coverage: routing.length ? accepted.length / routing.length : null, acceptedAccuracy: accepted.length ? correct / accepted.length : null },
    expectedHost: { expected: host.length, correctAbstentions: hostCorrect, correctness: host.length ? hostCorrect / host.length : null },
    wrongAcceptances: rows.filter(row => row.outcome === 'accepted' && !row.correct).length,
    outcomes: { accepted: rows.filter(row => row.outcome === 'accepted').length,
      abstained: rows.filter(row => row.outcome === 'abstained').length, errors: rows.filter(row => row.outcome === 'error').length },
  };
}

function aggregate(report) {
  const arms = report.rounds.flatMap(round => round.arms), costs = arms.map(arm => arm.cost);
  const bases = [...new Set(costs.map(cost => cost.basis))];
  return { ...metrics(arms.flatMap(arm => arm.rows)), requests: arms.reduce((total, arm) => total + arm.requests, 0),
    aggregateErrors: arms.filter(arm => arm.aggregateError !== null).length,
    cost: { estimatedProviderUsd: sum(costs.filter(cost => cost.basis === 'provider_pricing_estimate').map(cost => cost.estimatedProviderUsd)),
      reportedProviderUsd: sum(costs.filter(cost => cost.basis === 'provider_reported_credit_charge').map(cost => cost.reportedProviderUsd)),
      accountedProviderUsd: sum(costs.map(cost => cost.complete ? cost.estimatedProviderUsd ?? cost.reportedProviderUsd : null)),
      knownUsageUsd: sum(costs.map(cost => cost.knownUsageUsd)), bases, mixedBases: bases.length > 1,
      accountingScope: 'Defined arm billing scopes only; OpenRouter account credits exclude possible BYOK upstream charges. Not an invoice or measured savings.',
      unknownArms: costs.filter(cost => !cost.complete).length, cashChargeUsd: null, hostCostUsd: null, currency: 'USD' } };
}

function compare(round) {
  if (round.arms.length !== 2) return;
  const [first, second] = round.arms, other = new Map(second.rows.map(row => [row.id, row]));
  const signature = row => JSON.stringify([row.outcome, row.routeId, row.requiresHostApproval, row.reason]);
  round.disagreementIds = first.rows.filter(row => signature(row) !== signature(other.get(row.id))).map(row => row.id);
  const acceptedIds = arm => arm.rows.filter(row => row.outcome === 'accepted').map(row => row.id);
  round.comparison = {
    bothErrorFree: round.arms.every(arm => arm.metrics.outcomes.errors === 0),
    sameAcceptedCaseIds: JSON.stringify(acceptedIds(first)) === JSON.stringify(acceptedIds(second)),
    matchingDecisions: round.disagreementIds.length === 0,
    speedupClaimed: false,
  };
}

/** One request per arm/round, no retries, no worker execution. Both keys are required up front. */
export async function evaluateLlmControl(fixtureOrCases, options = {}) {
  const settings = validateSettings(options, ['apiKeys', 'onProgress']);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') fail('INVALID_EVALUATION_OPTIONS');
  const deps = await resolveDependencies(options, true), { prepared, requests } = await prepare(fixtureOrCases, settings, deps);
  const keys = credentials(options.apiKeys ?? {}, settings.provider);
  const report = {
    schemaVersion: 1, status: 'running', provider: settings.provider, synthetic: Array.isArray(fixtureOrCases) ? null : true, humanValidated: false, startedAt: new Date().toISOString(), completedAt: null,
    caseCount: prepared.scoring.length, plannedRequests: settings.rounds * 2, maxRequests: LIMITS.maxRequests,
    datasetSha256: prepared.datasetSha256, packetSha256: prepared.packetSha256, requestBytes: requests,
    models: { jev: 'jev-1.13.0', [settings.provider]: settings.model }, limits: { ...LIMITS }, rounds: [],
    measurement: {
      scope: 'Matched pre-labeled routing decisions only; no full workflow, news retrieval, worker execution, handoff or external write.',
      groundTruth: 'Locally supplied expected labels, not an independent human-validated benchmark. Fixture objects declare synthetic samples; bare case arrays have unknown provenance.',
      packet: 'Identical anonymous task/evidence IDs, route definitions, policy and task order for both arms. Labels and original case IDs stay evaluator-local.',
      datasetHashBasis: 'SHA-256 of JSON.stringify(cases), not original fixture file bytes. packetSha256 hashes JSON.stringify(packet).',
      timing: 'processingLatencyMs surrounds the adapter including parsing/validation/billing settlement and excludes checkpoint I/O.',
      policyDifference: 'JEV may abstain through probability thresholds; the LLM uses strict schema plus NONE, without invented self-probability thresholds.',
      coldStart: 'The same 60-second deadline allows schema cold starts. Cache read/write evidence is retained; two ordered rounds do not eliminate provider/cache variability.',
      cost: 'Estimated API usage and provider-reported account credits are separate columns. Accounted totals combine defined billing scopes only, exclude possible OpenRouter BYOK upstream charges, and are not invoice totals or measured savings.',
      hostSavingsMeasured: false, fullWorkflowMeasured: false, speedupClaimed: false, retries: 0,
    },
  };
  let allRequests = 0;
  const checkpoint = async () => { report.metrics = aggregate(report); if (options.onProgress) await options.onProgress(structuredClone(report)); };
  for (let number = 1; number <= settings.rounds; number++) {
    const round = { number, order: number === 1 ? ['jev', settings.provider] : [settings.provider, 'jev'], arms: [], disagreementIds: [], comparison: null };
    report.rounds.push(round);
    for (const name of round.order) {
      let armRequests = 0;
      const fetchImpl = async (input, request) => {
        if (armRequests >= 1 || allRequests >= LIMITS.maxRequests) fail('CALL_BUDGET_EXHAUSTED');
        if (request?.method !== 'POST') fail('INVALID_ADAPTER_RESULT');
        armRequests++; allRequests++;
        return deps.fetchImpl(input, request);
      };
      let raw, thrown = false;
      const started = now();
      try {
        const packet = structuredClone(prepared.packet);
        raw = name === 'jev' ? await deps.runJevControl(packet, { apiKey: keys.typesafe, timeoutMs: LIMITS.timeoutMs, fetchImpl })
          : await deps[PROVIDERS[settings.provider].run](packet, { apiKey: keys[settings.provider], model: settings.model,
            timeoutMs: LIMITS.timeoutMs, maxOutputTokens: LIMITS.maxOutputTokens, fetchImpl });
      } catch { thrown = true; }
      const processingLatencyMs = Math.max(0, now() - started);
      const source = record(raw) ? raw : {};
      const decisions = Array.isArray(source.decisions) ? source.decisions : [];
      const byId = new Map(decisions.filter(record).map(row => [row.id, row]));
      const validEnvelope = !thrown && decisions.length === prepared.scoring.length && byId.size === decisions.length
        && prepared.scoring.every(row => byId.has(row.opaqueId));
      const aggregateError = validEnvelope ? null : thrown ? 'EVALUATION_ARM_FAILED' : 'INVALID_ADAPTER_RESULT';
      const fallbackCost = { estimatedProviderUsd: armRequests === 0 ? 0 : null, reportedProviderUsd: armRequests === 0 ? 0 : null,
        knownUsageUsd: 0, complete: armRequests === 0 };
      const arm = {
        name, status: 'complete', aggregateError, requestedModel: name === 'jev' ? 'jev-1.13.0' : settings.model,
        observedModel: safeModel(source.observedModel), observedServiceTier: ['default', 'priority', 'fast', 'flex', 'scale', 'auto'].includes(source.observedServiceTier) ? source.observedServiceTier : null,
        observedProvider: source.observedProvider === 'OpenAI' ? 'OpenAI' : null,
        httpStatus: Number.isSafeInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599 ? source.httpStatus : null,
        providerErrorCode: PROVIDER_ERROR_CODES.has(source.providerErrorCode) ? source.providerErrorCode : null,
        providerErrorType: PROVIDER_ERROR_TYPES.has(source.providerErrorType) ? source.providerErrorType : null,
        processingLatencyMs, adapterWallLatencyMs: finite(source.wallLatencyMs), requests: armRequests,
        reportedRequests: count(source.requests), usage: sanitizeUsage(source.usage), cost: sanitizeCost(source.cost ?? fallbackCost, name),
        rows: prepared.scoring.map((item, index) => sanitizeRow(validEnvelope ? byId.get(item.opaqueId)
          : { outcome: 'error', reason: aggregateError }, item, prepared.packet.tasks[index])),
      };
      arm.metrics = metrics(arm.rows); round.arms.push(arm); compare(round);
      await checkpoint();
    }
  }
  report.status = 'complete'; report.completedAt = new Date().toISOString(); await checkpoint();
  return report;
}

async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('INVALID_FILE');
    if (stat.size > limit) fail('INPUT_TOO_LARGE');
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > limit) fail('INPUT_TOO_LARGE');
    return buffer.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await file.close(); }
}

async function loadCredentials(env, envFile, provider) {
  const selected = { typesafe: env?.TYPESAFE_API_KEY ?? '', [provider]: env?.[PROVIDERS[provider].envKey] ?? '' };
  for (const value of Object.values(selected)) if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value)) fail('INVALID_CREDENTIALS');
  if ((!selected.typesafe.trim() || !selected[provider].trim()) && envFile !== undefined) {
    let parsed;
    try { parsed = parseEnv(await readBounded(resolve(envFile), 65536)); }
    catch { fail('ENV_FILE_READ_ERROR'); }
    if (!selected.typesafe.trim()) selected.typesafe = parsed.TYPESAFE_API_KEY ?? '';
    if (!selected[provider].trim()) selected[provider] = parsed[PROVIDERS[provider].envKey] ?? '';
  }
  return credentials(selected, provider);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (Object.hasOwn(flags, flag)) return null;
    if (['--live', '--preflight'].includes(flag)) { flags[flag] = true; continue; }
    if (!['--env-file', '--output', '--rounds', '--model', '--provider', '--cases'].includes(flag)) return null;
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    flags[flag] = value;
  }
  if (Boolean(flags['--live']) === Boolean(flags['--preflight'])) return null;
  if (flags['--live'] && !flags['--output']) return null;
  if (flags['--preflight'] && (flags['--env-file'] || flags['--output'])) return null;
  if (flags['--rounds'] !== undefined && !['1', '2'].includes(flags['--rounds'])) return null;
  const provider = flags['--provider'] ?? 'openai';
  if (!Object.hasOwn(PROVIDERS, provider)) return null;
  if (flags['--model'] !== undefined && flags['--model'] !== PROVIDERS[provider].model) return null;
  return flags;
}

async function checkpointFile(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`; let file;
  try {
    file = await open(temporary, 'wx', 0o600); await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await file.sync(); await file.close(); file = null; await rename(temporary, path);
  } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export async function runLlmControlEvaluationCli(argv, dependencies = {}) {
  if (!known(dependencies, ['env', ...DEPENDENCIES])) return stop('INVALID_ARGUMENTS');
  const flags = parseArguments(argv);
  if (!flags) return stop('INVALID_ARGUMENTS');
  if (flags.help) return { exitCode: 0, result: { status: 'help',
    invocation: 'node -- benchmarks/llm-control-eval.mjs --live --output new-report.json [--env-file .env] [--rounds 1|2] [--provider openai|openrouter] [--model gpt-6-luna|openai/gpt-6-luna] [--cases cases.json]',
    preflight: 'Use --preflight instead of --live/--output/--env-file for offline hashes and request limits only; no key or network access.',
    scope: 'Matched synthetic decisions, not human-validated or a full workflow. TYPESAFE_API_KEY plus the selected provider key (OPENAI_API_KEY by default, OPENROUTER_API_KEY for openrouter) are required before either paid arm; no cross-provider key fallback. Model defaults to gpt-6-luna for openai or openai/gpt-6-luna for openrouter. At most four POSTs, no retries. Existing output is refused.',
  } };
  let fixture;
  try {
    fixture = JSON.parse(await readBounded(flags['--cases'] ? resolve(flags['--cases']) : new URL('./news-triage-cases.json', import.meta.url), LIMITS.maxFileBytes));
    if (!record(fixture) || fixture.schemaVersion !== 1 || fixture.synthetic !== true) fail('INVALID_EVALUATION_CASES');
  }
  catch (error) { return stop(error?.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES'); }
  const provider = flags['--provider'] ?? 'openai';
  const options = { rounds: Number(flags['--rounds'] ?? 2), model: flags['--model'] ?? PROVIDERS[provider].model, provider };
  for (const key of DEPENDENCIES) if (dependencies[key] !== undefined) options[key] = dependencies[key];
  let preflight;
  try { preflight = await preflightLlmControl(fixture, options); }
  catch (error) { return stop(error?.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES'); }
  if (flags['--preflight']) return { exitCode: 0, result: preflight };
  let apiKeys;
  try { apiKeys = await loadCredentials(dependencies.env ?? process.env, flags['--env-file'], provider); }
  catch (error) { return stop(['MISSING_TYPESAFE_API_KEY', 'MISSING_OPENAI_API_KEY', 'MISSING_OPENROUTER_API_KEY', 'INVALID_CREDENTIALS', 'ENV_FILE_READ_ERROR'].includes(error?.message) ? error.message : 'INVALID_CREDENTIALS'); }
  const output = resolve(flags['--output']);
  try { const reserved = await open(output, 'wx', 0o600); await reserved.close(); }
  catch (error) { return stop(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_UNAVAILABLE'); }
  let last = { schemaVersion: 1, status: 'running', provider, synthetic: true, humanValidated: false, rounds: [] };
  try {
    await checkpointFile(output, last);
    const report = await evaluateLlmControl(fixture, { ...options, apiKeys,
      onProgress: async value => { last = value; await checkpointFile(output, value); },
    });
    return { exitCode: 0, result: { status: 'complete', provider: report.provider, synthetic: report.synthetic, humanValidated: false,
      caseCount: report.caseCount, rounds: report.rounds.length, datasetSha256: report.datasetSha256, packetSha256: report.packetSha256, metrics: report.metrics } };
  } catch {
    await checkpointFile(output, { ...last, status: 'failed', reason: 'EVALUATION_FAILED' }).catch(() => {});
    return stop('EVALUATION_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLlmControlEvaluationCli(process.argv.slice(2)).catch(() => stop('EVALUATION_FAILED')).then(({ result, exitCode }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = exitCode;
  });
}
