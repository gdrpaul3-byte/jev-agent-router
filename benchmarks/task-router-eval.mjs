#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRouteRequest } from '../src/router.mjs';

const MAX_CASES = 100;
const MAX_FILE_BYTES = 1000000;
const ACCEPTED = new Set(['ready', 'shadow', 'review_required']);
const ABSTENTIONS = new Set(['NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE']);
const REASONS = new Set([...ABSTENTIONS, 'INVALID_INPUT', 'INVALID_CONFIGURATION', 'INPUT_TOO_LARGE', 'MISSING_API_KEY',
  'CALL_BUDGET_EXHAUSTED', 'INVALID_RESPONSE', 'HTTP_ERROR', 'REQUEST_FAILED', 'TIMEOUT', 'STATE_BUSY', 'STATE_INVALID',
  'STATE_DIR_REQUIRED', 'STATE_WRITE_FAILED', 'STATE_READ_FAILED', 'STATE_IO_ERROR', 'STATE_CAPACITY_EXCEEDED', 'TASK_REVISION_CONFLICT', 'TASK_OUTCOME_UNKNOWN',
  'HANDOFF_MISMATCH', 'HANDOFF_WRITE_FAILED', 'JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID', 'EVALUATION_RUN_FAILED', 'INVALID_RUNNER_RESULT']);
const STATUSES = new Set([...ACCEPTED, 'needs_host', 'bypassed', 'dry_run']);
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeModel = value => typeof value === 'string' && /^jev-(?:latest|[0-9][A-Za-z0-9._-]{0,63})$/.test(value) ? value : null;
const knownFields = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const fail = reason => { throw new Error(reason); };
const stop = reason => ({ exitCode: 2, result: { status: 'needs_host', reason } });
const now = () => performance.now();

function prepareCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES) fail('INVALID_EVALUATION_CASES');
  const seen = new Set(), taskKeys = new Set();
  return cases.map(item => {
    if (!knownFields(item, ['id', 'label', 'input', 'expected']) || !id(item.id) || seen.has(item.id)
        || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100) fail('INVALID_EVALUATION_CASES');
    const prepared = prepareRouteRequest(item.input);
    if (prepared.status !== 'prepared') fail('INVALID_EVALUATION_CASES');
    const key = `${prepared.snapshot.task.id}:${prepared.snapshot.task.revision}`;
    if (taskKeys.has(key)) fail('INVALID_EVALUATION_CASES');
    taskKeys.add(key); seen.add(item.id);
    let expected;
    if (knownFields(item.expected, ['needsHost']) && item.expected.needsHost === true) expected = { needsHost: true };
    else if (knownFields(item.expected, ['routeId', 'requiresHostApproval']) && id(item.expected.routeId)) {
      const route = prepared.snapshot.routes.find(route => route.id === item.expected.routeId && route.available);
      if (!route || typeof item.expected.requiresHostApproval !== 'boolean' || item.expected.requiresHostApproval !== route.requiresApproval) fail('INVALID_EVALUATION_CASES');
      expected = { routeId: item.expected.routeId, requiresHostApproval: item.expected.requiresHostApproval };
    } else fail('INVALID_EVALUATION_CASES');
    return { id: item.id, label: item.label, input: prepared.snapshot, expected };
  });
}

function sanitizeCost(source) {
  const cost = record(source) ? source : {};
  const result = {};
  for (const key of ['calls', 'inputTokens', 'outputTokens', 'knownInputTokens', 'knownOutputTokens', 'inputUsageCalls', 'outputUsageCalls', 'pendingRequests', 'pendingUsage', 'errors', 'requestBytes', 'knownRequestBytes', 'questionCount']) result[key] = count(cost[key]);
  for (const key of ['estimatedJevUsd', 'knownUsageUsd', 'inputUsdPerMillion']) result[key] = finite(cost[key]);
  result.complete = cost.complete === true && result.estimatedJevUsd !== null;
  result.currency = 'USD'; result.cashChargeUsd = null; result.hostCostUsd = null;
  return result;
}

function sanitizeRequests(source) {
  if (!Array.isArray(source) || source.length > 10000) return null;
  return source.map(item => {
    const entry = record(item) ? item : {};
    const result = {};
    for (const key of ['index', 'inputTokens', 'outputTokens', 'requestBytes', 'questionCount', 'httpStatus']) result[key] = count(entry[key]);
    for (const key of ['latencyMs', 'usageLatencyMs']) result[key] = finite(entry[key]);
    for (const key of ['responsePending', 'usagePending', 'usageParsed']) result[key] = typeof entry[key] === 'boolean' ? entry[key] : null;
    result.model = safeModel(entry.model);
    result.error = entry.error === null ? null : ['HTTP_ERROR', 'TRANSPORT_FAILED'].includes(entry.error) ? entry.error : 'UNKNOWN_ERROR';
    return result;
  });
}

function sanitizeResult(value, item) {
  const raw = record(value) ? value : {};
  const status = STATUSES.has(raw.status) ? raw.status : 'needs_host';
  const routeId = item.input.routes.some(route => route.id === raw.recommendationId && route.available) ? raw.recommendationId : null;
  const result = {
    status, reason: REASONS.has(raw.reason) ? raw.reason : raw.reason === undefined ? null : 'UNKNOWN_REASON',
    recommendationId: routeId,
    effectiveRouteId: item.input.routes.some(route => route.id === raw.effectiveRouteId) ? raw.effectiveRouteId : null,
    requiresHostApproval: typeof raw.requiresHostApproval === 'boolean' ? raw.requiresHostApproval : null,
    recommendationRequiresHostApproval: typeof raw.recommendationRequiresHostApproval === 'boolean' ? raw.recommendationRequiresHostApproval : null,
    confidence: finite(raw.confidence) !== null && raw.confidence <= 1 ? raw.confidence : null,
    margin: finite(raw.margin) !== null && raw.margin <= 1 ? raw.margin : null,
    model: safeModel(raw.model), latencyMs: finite(raw.latencyMs), replayed: raw.replayed === true,
    cost: sanitizeCost(raw.cost), requests: sanitizeRequests(raw.requests),
  };
  if (!STATUSES.has(raw.status) || (ACCEPTED.has(status) && routeId === null)) { result.status = 'needs_host'; result.reason = 'INVALID_RUNNER_RESULT'; }
  if (raw.decisionCost !== undefined) result.decisionCost = sanitizeCost(raw.decisionCost);
  if (raw.decisionRequests !== undefined) result.decisionRequests = sanitizeRequests(raw.decisionRequests);
  return result;
}

const nullableSum = values => values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
const distribution = values => {
  if (!values.length) return { samples: 0, mean: null, median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};

function metrics(cases) {
  const routing = cases.filter(item => !item.expected.needsHost);
  const acceptedRouting = routing.filter(item => item.outcome === 'accepted');
  const expectedHost = cases.filter(item => item.expected.needsHost);
  const costs = cases.map(item => item.result.cost);
  return {
    routing: { expected: routing.length, accepted: acceptedRouting.length, correct: acceptedRouting.filter(item => item.correct).length,
      coverage: routing.length ? acceptedRouting.length / routing.length : null,
      acceptedAccuracy: acceptedRouting.length ? acceptedRouting.filter(item => item.correct).length / acceptedRouting.length : null },
    expectedHost: { expected: expectedHost.length, correctAbstentions: expectedHost.filter(item => item.correct).length,
      correctness: expectedHost.length ? expectedHost.filter(item => item.correct).length / expectedHost.length : null },
    falseAcceptances: expectedHost.filter(item => item.outcome === 'accepted').length,
    outcomes: { accepted: cases.filter(item => item.outcome === 'accepted').length,
      abstained: cases.filter(item => item.outcome === 'abstained').length, errors: cases.filter(item => item.outcome === 'error').length },
    replayed: cases.filter(item => item.result.replayed).length,
    wallLatencyMs: distribution(cases.map(item => item.wallLatencyMs)),
    providerLatencyMs: distribution(cases.filter(item => !item.result.replayed && item.providerLatencyMs !== null).map(item => item.providerLatencyMs)),
    cost: {
      calls: nullableSum(costs.map(cost => cost.calls)), knownCalls: costs.reduce((sum, cost) => sum + (cost.calls ?? 0), 0),
      inputTokens: nullableSum(costs.map(cost => cost.inputTokens)), knownInputTokens: costs.reduce((sum, cost) => sum + (cost.knownInputTokens ?? 0), 0),
      estimatedJevUsd: nullableSum(costs.map(cost => cost.estimatedJevUsd)), knownUsageUsd: costs.reduce((sum, cost) => sum + (cost.knownUsageUsd ?? 0), 0),
      unknownCases: costs.filter(cost => cost.estimatedJevUsd === null || !cost.complete).length,
      cashChargeUsd: null, hostCostUsd: null, currency: 'USD',
    },
  };
}

/** Uses an injected runner in tests. Calls are sequential; only the runner owns paid-call state. */
export async function evaluateRouterCases(cases, {
  runRoutingTask, stateDir, envFile, apiKey = '', mode = 'shadow', maxCalls = cases?.length, onProgress,
} = {}) {
  const prepared = prepareCases(cases);
  if (!['shadow', 'active'].includes(mode) || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_CASES
      || typeof stateDir !== 'string' || !stateDir.trim() || (onProgress !== undefined && typeof onProgress !== 'function')) fail('INVALID_EVALUATION_OPTIONS');
  const runner = runRoutingTask ?? (await import('../src/router-task.mjs')).runRoutingTask;
  if (typeof runner !== 'function') fail('INVALID_EVALUATION_OPTIONS');
  const report = {
    schemaVersion: 1, status: 'running', synthetic: true, mode, startedAt: new Date().toISOString(), completedAt: null,
    attemptedCases: prepared.length, maxCalls, cases: [],
    measurement: {
      taskCompletionMeasured: false, hostSavingsMeasured: false,
      scope: 'Pre-labeled synthetic routing choices only; no worker or browser executes.',
      providerLatency: 'Sum of current request usageLatencyMs (response JSON), falling back to headers latency when unavailable; replays excluded.',
      cost: 'Current invocation TypeSafe list-price estimates; original replay decision cost is retained separately and not added again.',
      pricingSource: 'https://docs.typesafe.ai/models',
    },
  };
  for (const item of prepared) {
    const started = now(); let raw;
    try { raw = await runner(item.input, { config: { mode, maxCalls }, stateDir, envFile, apiKey }); }
    catch { raw = { status: 'needs_host', reason: 'EVALUATION_RUN_FAILED' }; }
    const wallLatencyMs = Math.max(0, now() - started);
    const result = sanitizeResult(raw, item);
    const outcome = ACCEPTED.has(result.status) ? 'accepted'
      : result.status === 'needs_host' && ABSTENTIONS.has(result.reason) ? 'abstained' : 'error';
    const correct = item.expected.needsHost ? outcome === 'abstained'
      : outcome === 'accepted' && result.recommendationId === item.expected.routeId && result.recommendationRequiresHostApproval === item.expected.requiresHostApproval;
    const providerLatencyMs = result.replayed || !result.requests?.length ? null
      : nullableSum(result.requests.map(request => request.usageLatencyMs ?? request.latencyMs));
    report.cases.push({ id: item.id, label: item.label, expected: item.expected, outcome, correct, wallLatencyMs, providerLatencyMs, result });
    report.metrics = metrics(report.cases);
    if (onProgress) await onProgress(report);
  }
  report.status = 'complete'; report.completedAt = new Date().toISOString();
  return report;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (Object.hasOwn(flags, flag)) return null;
    if (flag === '--live') { flags[flag] = true; continue; }
    if (!['--state-dir', '--output', '--env-file', '--cases', '--mode', '--limit', '--max-calls'].includes(flag)) return null;
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    flags[flag] = value;
  }
  if (!flags['--live'] || !flags['--state-dir'] || !flags['--output']) return null;
  if (flags['--mode'] && !['shadow', 'active'].includes(flags['--mode'])) return null;
  for (const flag of ['--limit', '--max-calls']) if (flags[flag] !== undefined && (!/^[1-9][0-9]*$/.test(flags[flag]) || Number(flags[flag]) > MAX_CASES)) return null;
  return flags;
}

async function readCasesFile(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('INVALID_EVALUATION_CASES');
    if (stat.size > MAX_FILE_BYTES) fail('INPUT_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) fail('INPUT_TOO_LARGE');
    const dataset = JSON.parse(bytes.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, ''));
    if (!record(dataset) || dataset.schemaVersion !== 1 || dataset.synthetic !== true) fail('INVALID_EVALUATION_CASES');
    return prepareCases(dataset.cases);
  } finally { await file.close(); }
}

/** CLI never silently opts into paid inference and reserves output before dispatch. */
export async function runRouterEvaluationCli(argv, { env = process.env, runRoutingTask } = {}) {
  const flags = parseArguments(argv);
  if (!flags) return stop('INVALID_ARGUMENTS');
  if (flags.help) return { exitCode: 0, result: { status: 'help',
    invocation: 'node -- benchmarks/task-router-eval.mjs --live --state-dir .jev-router-eval --output report.json [--env-file .env] [--limit 18] [--max-calls 18] [--mode shadow|active] [--cases cases.json]',
    scope: 'Synthetic decisions only. Default shadow mode creates no worker handoffs; no mode executes workers. Refuses existing output files. At most 100 cases/calls. TYPESAFE_API_KEY or an explicit env file is required.',
  } };
  const apiKey = typeof env?.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY : '';
  if (!apiKey.trim() && !flags['--env-file']) return stop('MISSING_API_KEY');
  let cases;
  try {
    cases = await readCasesFile(flags['--cases'] ? resolve(flags['--cases']) : new URL('./task-router-cases.json', import.meta.url));
    if (flags['--limit']) cases = cases.slice(0, Number(flags['--limit']));
  } catch (error) { return stop(error?.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES'); }
  let output;
  try { output = await open(resolve(flags['--output']), 'wx', 0o600); }
  catch (error) { return stop(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_UNAVAILABLE'); }
  const save = async report => {
    const data = Buffer.from(`${JSON.stringify(report, null, 2)}\n`); let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await output.write(data, offset, data.length - offset, offset);
      if (!bytesWritten) fail('OUTPUT_WRITE_FAILED'); offset += bytesWritten;
    }
    await output.truncate(data.length); await output.sync();
  };
  try {
    await save({ schemaVersion: 1, status: 'running', cases: [] });
    const report = await evaluateRouterCases(cases, { runRoutingTask, stateDir: flags['--state-dir'], envFile: flags['--env-file'], apiKey,
      mode: flags['--mode'] ?? 'shadow', maxCalls: flags['--max-calls'] ? Number(flags['--max-calls']) : cases.length, onProgress: save });
    await save(report);
    return { exitCode: 0, result: { status: 'complete', synthetic: true, mode: report.mode, cases: report.cases.length, metrics: report.metrics } };
  } catch { return stop('EVALUATION_FAILED'); }
  finally { await output.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRouterEvaluationCli(process.argv.slice(2)).catch(() => stop('EVALUATION_FAILED')).then(({ result, exitCode }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = exitCode;
  });
}
