#!/usr/bin/env node
import { open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { prepareRouteRequest, decideRoute as defaultSingle } from '../src/router.mjs';
import { decideRouteBatch as defaultBatch } from '../src/router-batch.mjs';
import { createMeteredFetch, summarizeBilling } from '../src/meter.mjs';
import { loadApiKey } from '../src/config.mjs';

const MAX_BYTES = 1000000;
const CONFIG = Object.freeze({ mode: 'shadow', model: 'jev-1.13.0', maxInputBytes: 60000, timeoutMs: 10000, maxCalls: 26 });
const ABSTENTIONS = new Set(['NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE']);
const REASONS = new Set([...ABSTENTIONS, 'INVALID_INPUT', 'INVALID_CONFIGURATION', 'INPUT_TOO_LARGE', 'MISSING_API_KEY',
  'CALL_BUDGET_EXHAUSTED', 'INVALID_RESPONSE', 'HTTP_ERROR', 'REQUEST_FAILED', 'TIMEOUT',
  'INVALID_RUNNER_RESULT', 'EVALUATION_RUN_FAILED']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownFields = (value, fields) => record(value) && Object.keys(value).every(key => fields.includes(key));
const validId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  && !['NONE', '__proto__', 'prototype', 'constructor'].includes(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const probability = value => finite(value) !== null && value <= 1 ? value : null;
const safeModel = value => typeof value === 'string' && /^jev-(?:latest|[0-9][A-Za-z0-9._-]{0,63})$/.test(value) ? value : null;
const safeReason = reason => REASONS.has(reason) ? reason : 'UNKNOWN_REASON';
const fail = reason => { throw new Error(reason); };
const stop = reason => ({ exitCode: 2, result: { status: 'needs_host', reason } });
const now = () => performance.now();
const nullableSum = values => {
  if (values.some(value => value === null)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) ? sum : null;
};

function prepareCases(cases) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 12) fail('INVALID_EVALUATION_CASES');
  const ids = new Set(), tasks = new Set();
  return cases.map(item => {
    if (!knownFields(item, ['id', 'label', 'input', 'expected']) || !validId(item.id) || ids.has(item.id)
        || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200) fail('INVALID_EVALUATION_CASES');
    const prepared = prepareRouteRequest(item.input, CONFIG);
    if (prepared.status !== 'prepared' || tasks.has(prepared.snapshot.task.id)) fail('INVALID_EVALUATION_CASES');
    ids.add(item.id); tasks.add(prepared.snapshot.task.id);
    let expected;
    if (knownFields(item.expected, ['needsHost']) && item.expected.needsHost === true) expected = { needsHost: true };
    else if (knownFields(item.expected, ['routeId', 'requiresHostApproval']) && validId(item.expected.routeId)) {
      const route = prepared.snapshot.routes.find(route => route.id === item.expected.routeId && route.available);
      if (!route || typeof item.expected.requiresHostApproval !== 'boolean'
          || item.expected.requiresHostApproval !== route.requiresApproval) fail('INVALID_EVALUATION_CASES');
      expected = { routeId: item.expected.routeId, requiresHostApproval: item.expected.requiresHostApproval };
    } else fail('INVALID_EVALUATION_CASES');
    return { id: item.id, input: prepared.snapshot, expected };
  });
}

function sanitizedCost(value) {
  const source = record(value) ? value : {}, result = {};
  for (const key of ['calls', 'inputTokens', 'outputTokens', 'knownInputTokens', 'knownOutputTokens', 'inputUsageCalls',
    'outputUsageCalls', 'pendingRequests', 'pendingUsage', 'errors', 'requestBytes', 'knownRequestBytes', 'questionCount']) result[key] = count(source[key]);
  for (const key of ['estimatedJevUsd', 'knownUsageUsd']) result[key] = finite(source[key]);
  result.complete = source.complete === true && result.estimatedJevUsd !== null;
  result.currency = 'USD'; result.inputUsdPerMillion = 0.042;
  result.cashChargeUsd = null; result.hostCostUsd = null;
  return result;
}

function sanitizedRequests(value) {
  if (!Array.isArray(value) || value.length > CONFIG.maxCalls) return null;
  return value.map(item => {
    const source = record(item) ? item : {}, result = {};
    for (const key of ['index', 'inputTokens', 'outputTokens', 'requestBytes', 'questionCount', 'httpStatus']) result[key] = count(source[key]);
    for (const key of ['latencyMs', 'usageLatencyMs']) result[key] = finite(source[key]);
    for (const key of ['responsePending', 'usagePending', 'usageParsed']) result[key] = typeof source[key] === 'boolean' ? source[key] : null;
    result.model = safeModel(source.model);
    result.error = source.error === null ? null : ['HTTP_ERROR', 'TRANSPORT_FAILED'].includes(source.error) ? source.error : 'UNKNOWN_ERROR';
    return result;
  });
}

function sanitizedDecision(value, item) {
  const raw = record(value) ? value : {};
  const validSelected = raw.status === 'selected' && typeof raw.requiresHostApproval === 'boolean'
    && item.input.routes.some(route => route.id === raw.routeId && route.available);
  return {
    status: validSelected ? 'selected' : 'needs_host',
    reason: validSelected ? null : raw.status === 'needs_host' ? safeReason(raw.reason) : 'INVALID_RUNNER_RESULT',
    routeId: validSelected ? raw.routeId : null,
    requiresHostApproval: validSelected ? raw.requiresHostApproval : null,
    confidence: probability(raw.confidence), margin: probability(raw.margin),
    model: safeModel(raw.model), latencyMs: finite(raw.latencyMs),
  };
}

function resultRow(item, raw) {
  const decision = sanitizedDecision(raw, item);
  const outcome = decision.status === 'selected' ? 'accepted' : ABSTENTIONS.has(decision.reason) ? 'abstained' : 'error';
  const correct = item.expected.needsHost ? outcome === 'abstained'
    : outcome === 'accepted' && decision.routeId === item.expected.routeId && decision.requiresHostApproval === item.expected.requiresHostApproval;
  return { id: item.id, expected: item.expected, decision, outcome, correct };
}

function rowMetrics(rows) {
  const routing = rows.filter(row => !row.expected.needsHost), accepted = routing.filter(row => row.outcome === 'accepted');
  const host = rows.filter(row => row.expected.needsHost), correct = accepted.filter(row => row.correct).length;
  const correctHost = host.filter(row => row.correct).length;
  return {
    routing: { expected: routing.length, accepted: accepted.length, correct, coverage: routing.length ? accepted.length / routing.length : null,
      acceptedAccuracy: accepted.length ? correct / accepted.length : null },
    expectedHost: { expected: host.length, correctAbstentions: correctHost, correctness: host.length ? correctHost / host.length : null },
    falseAcceptances: host.filter(row => row.outcome === 'accepted').length,
    outcomes: { accepted: rows.filter(row => row.outcome === 'accepted').length,
      abstained: rows.filter(row => row.outcome === 'abstained').length, errors: rows.filter(row => row.outcome === 'error').length },
  };
}

function aggregateMetrics(report, attemptedRequests) {
  const cohorts = report.rounds.flatMap(round => round.cohorts), costs = cohorts.map(cohort => cohort.cost);
  return {
    ...rowMetrics(cohorts.flatMap(cohort => cohort.rows)), attemptedRequests,
    aggregateErrors: cohorts.filter(cohort => cohort.aggregateError !== null).length,
    cost: {
      calls: nullableSum(costs.map(cost => cost.calls)), inputTokens: nullableSum(costs.map(cost => cost.inputTokens)),
      knownInputTokens: nullableSum(costs.map(cost => cost.knownInputTokens)),
      estimatedJevUsd: nullableSum(costs.map(cost => cost.estimatedJevUsd)),
      knownUsageUsd: nullableSum(costs.map(cost => cost.knownUsageUsd)),
      unknownCohorts: costs.filter(cost => cost.estimatedJevUsd === null || !cost.complete).length,
      cashChargeUsd: null, hostCostUsd: null, currency: 'USD',
    },
  };
}

function disagreementIds(round) {
  const single = round.cohorts.find(cohort => cohort.kind === 'single'), batch = round.cohorts.find(cohort => cohort.kind === 'batch');
  if (!single || !batch || single.status !== 'complete' || batch.status !== 'complete') return [];
  const signature = row => JSON.stringify([row.outcome, row.decision.routeId, row.decision.requiresHostApproval, row.decision.reason]);
  const other = new Map(batch.rows.map(row => [row.id, row]));
  return single.rows.filter(row => !other.has(row.id) || signature(row) !== signature(other.get(row.id))).map(row => row.id);
}

/** Sequential cohort comparison only: no worker execution, ledger, retry or per-item batch billing. */
export async function evaluateNewsTriageCases(cases, options = {}) {
  const prepared = prepareCases(cases);
  if (!knownFields(options, ['rounds', 'apiKey', 'envFile', 'fetchImpl', 'decideRoute', 'decideRouteBatch', 'onProgress'])) fail('INVALID_EVALUATION_OPTIONS');
  const { rounds = 2, fetchImpl = globalThis.fetch, decideRoute = defaultSingle, decideRouteBatch = defaultBatch, onProgress } = options;
  if (![1, 2].includes(rounds) || ![fetchImpl, decideRoute, decideRouteBatch].every(value => typeof value === 'function')
      || (onProgress !== undefined && typeof onProgress !== 'function')) fail('INVALID_EVALUATION_OPTIONS');
  // Check the actual combined wire body before reading a key or paying for singles.
  // Always use the production pure dry-run path, not an injected paid runner.
  const preflight = await defaultBatch(prepared.map(item => item.input), { config: { ...CONFIG, mode: 'dry-run' } });
  if (preflight.status !== 'dry_run') fail(preflight.reason === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES');
  const apiKey = await loadApiKey({ apiKey: options.apiKey ?? '', envFile: options.envFile });
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) fail('MISSING_API_KEY');
  let attemptedRequests = 0;
  const boundedFetch = async (input, request) => {
    if (attemptedRequests >= CONFIG.maxCalls) fail('CALL_BUDGET_EXHAUSTED');
    attemptedRequests++;
    return fetchImpl(input, request);
  };
  const report = {
    schemaVersion: 1, status: 'running', synthetic: true, language: 'ko', startedAt: new Date().toISOString(), completedAt: null,
    config: { ...CONFIG }, caseCount: prepared.length, plannedCalls: (prepared.length + 1) * rounds,
    datasetSha256: createHash('sha256').update(JSON.stringify(prepared)).digest('hex'), rounds: [],
    measurement: {
      scope: 'Pre-labeled synthetic route decisions only. No news retrieval, worker execution, external posting or handoffs.',
      hostSavingsMeasured: false, taskCompletionMeasured: false, retries: 0,
      comparison: 'Round 1 sequential singles then one batch; round 2 reverses cohort order. Same fixed inputs and model.',
      latency: 'processingLatencyMs is the sum of single decision+meter settlement intervals, or the batch decision interval, excluding checkpoint I/O. wallLatencyMs is a harness diagnostic including single checkpoints between calls.',
      billing: 'One billing record per cohort. Batch usage is not divided among items. Missing usage remains null.',
      pricingSource: 'https://docs.typesafe.ai/models', pricingVerifiedOn: '2026-09-24',
    },
  };
  const checkpoint = async () => {
    report.metrics = aggregateMetrics(report, attemptedRequests);
    if (onProgress) await onProgress(structuredClone(report));
  };
  for (let number = 1; number <= rounds; number++) {
    const round = { number, order: number === 1 ? ['single', 'batch'] : ['batch', 'single'], cohorts: [], disagreementIds: [] };
    report.rounds.push(round);
    for (const kind of round.order) {
      const meter = createMeteredFetch({ fetchImpl: boundedFetch });
      const cohort = { kind, status: 'running', rows: [], aggregateError: null, processingLatencyMs: 0, wallLatencyMs: null,
        cost: sanitizedCost(summarizeBilling(meter.stats())), requests: [] };
      round.cohorts.push(cohort);
      const started = now();
      if (kind === 'single') {
        for (const item of prepared) {
          const callStarted = now(); let raw;
          try { raw = await decideRoute(item.input, { config: { ...CONFIG }, apiKey, fetchImpl: meter.fetchImpl }); }
          catch { raw = { status: 'needs_host', reason: 'EVALUATION_RUN_FAILED' }; }
          await meter.flush({ timeoutMs: Math.max(0, CONFIG.timeoutMs - (now() - callStarted)) });
          cohort.processingLatencyMs += Math.max(0, now() - callStarted);
          cohort.rows.push(resultRow(item, raw));
          cohort.cost = sanitizedCost(summarizeBilling(meter.stats())); cohort.requests = sanitizedRequests(meter.records());
          cohort.wallLatencyMs = Math.max(0, now() - started); cohort.metrics = rowMetrics(cohort.rows);
          await checkpoint();
        }
      } else {
        let raw;
        const before = attemptedRequests;
        const callStarted = now();
        try { raw = await decideRouteBatch(prepared.map(item => item.input), { config: { ...CONFIG }, apiKey, fetchImpl: boundedFetch }); }
        catch { raw = { status: 'needs_host', reason: 'EVALUATION_RUN_FAILED', cost: { calls: attemptedRequests - before } }; }
        cohort.processingLatencyMs = Math.max(0, now() - callStarted);
        cohort.cost = sanitizedCost(raw?.cost); cohort.requests = sanitizedRequests(raw?.requests);
        const identities = new Set(prepared.map(item => `${item.input.task.id}:${item.input.task.revision}`));
        const decisions = Array.isArray(raw?.decisions) ? raw.decisions : [];
        const keys = decisions.map(item => record(item) ? `${item.taskId}:${item.revision}` : null);
        const validBatch = raw?.status === 'decided' && decisions.length === prepared.length && new Set(keys).size === keys.length
          && keys.every(key => identities.has(key));
        if (!validBatch) cohort.aggregateError = raw?.status === 'needs_host' ? safeReason(raw.reason) : 'INVALID_RUNNER_RESULT';
        const byId = new Map(decisions.filter(record).map(item => [item.taskId, item]));
        cohort.rows = prepared.map(item => resultRow(item, validBatch ? byId.get(item.input.task.id)
          : { status: 'needs_host', reason: cohort.aggregateError }));
        // Aggregate/provider failures are errors, including when every item expected host review.
        if (!validBatch) for (const row of cohort.rows) { row.outcome = 'error'; row.correct = false; }
      }
      cohort.status = 'complete'; cohort.wallLatencyMs = Math.max(0, now() - started); cohort.metrics = rowMetrics(cohort.rows);
      round.disagreementIds = disagreementIds(round);
      await checkpoint();
    }
  }
  report.status = 'complete'; report.completedAt = new Date().toISOString();
  await checkpoint();
  return report;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (Object.hasOwn(flags, flag)) return null;
    if (flag === '--live') { flags[flag] = true; continue; }
    if (!['--output', '--env-file', '--cases', '--rounds'].includes(flag)) return null;
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    flags[flag] = value;
  }
  if (!flags['--live'] || !flags['--output']) return null;
  if (flags['--rounds'] !== undefined && !['1', '2'].includes(flags['--rounds'])) return null;
  return flags;
}

async function readCasesFile(path) {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) fail('INVALID_EVALUATION_CASES');
    if (metadata.size > MAX_BYTES) fail('INPUT_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > MAX_BYTES) fail('INPUT_TOO_LARGE');
    const data = JSON.parse(buffer.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, ''));
    if (!knownFields(data, ['schemaVersion', 'synthetic', 'language', 'description', 'cases']) || data.schemaVersion !== 1 || data.synthetic !== true) fail('INVALID_EVALUATION_CASES');
    prepareCases(data.cases);
    return data.cases;
  } finally { await file.close(); }
}

async function writeCheckpoint(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** Explicit opt-in; reserve a new output before any call and checkpoint every completed call. */
export async function runNewsTriageEvaluationCli(argv, dependencies = {}) {
  if (!knownFields(dependencies, ['env', 'fetchImpl', 'decideRoute', 'decideRouteBatch'])) return stop('INVALID_ARGUMENTS');
  const flags = parseArguments(argv);
  if (!flags) return stop('INVALID_ARGUMENTS');
  if (flags.help) return { exitCode: 0, result: { status: 'help',
    invocation: 'node -- benchmarks/news-triage-eval.mjs --live --output new-report.json [--env-file .env] [--rounds 1|2] [--cases cases.json]',
    scope: 'Pre-labeled synthetic news routing only. Default 2 rounds reverse single/batch cohort order. At most 26 POSTs; no retries or worker execution. Existing output is refused.',
    billing: 'Whole-request batch cost only; unknown usage stays null. TYPESAFE_API_KEY or one explicit env file is required. The report excludes input text, keys and local paths.',
  } };
  let cases;
  try { cases = await readCasesFile(flags['--cases'] ? resolve(flags['--cases']) : new URL('./news-triage-cases.json', import.meta.url)); }
  catch (error) { return stop(error?.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES'); }
  const outputPath = resolve(flags['--output']);
  try { const reserved = await open(outputPath, 'wx', 0o600); await reserved.close(); }
  catch (error) { return stop(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_UNAVAILABLE'); }
  let lastReport = { schemaVersion: 1, status: 'running', synthetic: true, rounds: [] };
  try {
    await writeCheckpoint(outputPath, lastReport);
    const env = dependencies.env ?? process.env;
    const report = await evaluateNewsTriageCases(cases, {
      apiKey: typeof env?.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY : '', envFile: flags['--env-file'],
      rounds: flags['--rounds'] ? Number(flags['--rounds']) : 2,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.decideRoute ? { decideRoute: dependencies.decideRoute } : {}),
      ...(dependencies.decideRouteBatch ? { decideRouteBatch: dependencies.decideRouteBatch } : {}),
      onProgress: async snapshot => { lastReport = snapshot; await writeCheckpoint(outputPath, snapshot); },
    });
    return { exitCode: 0, result: { status: 'complete', synthetic: true, caseCount: report.caseCount, rounds: report.rounds.length, metrics: report.metrics } };
  } catch (error) {
    const reason = ['MISSING_API_KEY', 'JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID', 'INPUT_TOO_LARGE', 'INVALID_EVALUATION_CASES'].includes(error?.message) ? error.message : 'EVALUATION_FAILED';
    await writeCheckpoint(outputPath, { ...lastReport, status: 'failed', reason }).catch(() => {});
    return stop(reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNewsTriageEvaluationCli(process.argv.slice(2)).catch(() => stop('EVALUATION_FAILED')).then(({ result, exitCode }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = exitCode;
  });
}
