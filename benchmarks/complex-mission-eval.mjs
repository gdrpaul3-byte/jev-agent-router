#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, mkdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createInferenceBudget } from '../src/inference-budget.mjs';

const ARMS = Object.freeze(['astra', 'luna', 'adaptive']);
const MODEL = 'openai/gpt-6-astra';
const SAFE_REASONS = new Set(['TIMEOUT', 'HTTP_ERROR', 'REQUEST_FAILED', 'INVALID_RESPONSE', 'NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE', 'CALL_BUDGET_EXHAUSTED', 'COST_BUDGET_EXHAUSTED', 'UNACCOUNTED_REQUEST', 'INVALID_CONFIGURATION', 'INVALID_INPUT', 'MISSING_API_KEY', 'PENDING_DECISION', 'STATE_BUSY', 'REFUSAL', 'INCOMPLETE_RESPONSE', 'UNEXPECTED_MODEL', 'UNEXPECTED_PROVIDER']);
for (const reason of ['INVALID_OUTPUT', 'INVALID_SCHEMA', 'UNEXPECTED_SERVICE_TIER', 'UNEXPECTED_TOOL', 'PROVIDER_ERROR',
  'STATE_LOCKED', 'STATE_INVALID', 'STATE_WRITE_FAILED', 'UNCERTAIN_PRIOR_ATTEMPT', 'PRIOR_ATTEMPT_REQUIRES_REVIEW',
  'EXPECTED_BUDGET_EXHAUSTED', 'UNKNOWN_PRIOR_COST', 'MISSING_TYPESAFE_API_KEY', 'MISSING_OPENROUTER_API_KEY', 'NO_ELIGIBLE_PROVIDER']) SAFE_REASONS.add(reason);
const fail = reason => { throw new Error(reason); };
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
const safeReason = reason => SAFE_REASONS.has(reason) ? reason : 'UNCLASSIFIED_FAILURE';
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const snapshot = value => JSON.parse(JSON.stringify(value));

export function createMissionSchedule(cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 8) fail('INVALID_MISSION_CASES');
  const groups = new Map();
  for (const item of cases) {
    if (!id(item?.id) || !['base', 'changed'].includes(item.variant) || !item.mission || !item.expected
        || !Array.isArray(item.routingInputs) || !item.routingInputs.length || item.routingInputs.length > 3 || !item.toolOutputs) fail('INVALID_MISSION_CASES');
    const group = groups.get(item.id) ?? {};
    if (group[item.variant]) fail('INVALID_MISSION_CASES');
    group[item.variant] = item; groups.set(item.id, group);
  }
  const schedule = [];
  for (const [missionId, group] of groups) {
    if (!group.base || !group.changed) fail('INVALID_MISSION_CASES');
    for (const [index, phase] of ['base', 'changed', 'exact_repeat'].entries()) {
      const order = [...ARMS.slice(index), ...ARMS.slice(0, index)];
      for (const arm of order) schedule.push({ missionId, phase, arm, case: group[phase === 'changed' ? 'changed' : 'base'] });
    }
  }
  return schedule;
}

async function dependencies(overrides = {}) {
  const result = { ...overrides };
  if (!result.prepareAdaptiveRoute || !result.runAdaptiveRoute) {
    const module = await import('../src/adaptive-router.mjs');
    result.prepareAdaptiveRoute ??= module.prepareAdaptiveRoute; result.runAdaptiveRoute ??= module.runAdaptiveRoute;
  }
  if (!result.prepareStructuredRequest || !result.runStructuredRequest) {
    const module = await import('../src/structured-llm.mjs');
    result.prepareStructuredRequest ??= module.prepareStructuredRequest; result.runStructuredRequest ??= module.runStructuredRequest;
  }
  if (!result.scoreMission) result.scoreMission = (await import('./complex-mission-cases.mjs')).scoreMission;
  return result;
}

function routingConfig(arm, missionId) {
  return { strategy: arm, difficulty: 'routine', namespace: 'complex-missions-v1', scope: `${missionId}-${arm}`,
    ttlSeconds: 1800, maxCalls: 2, budgetUsd: 1, timeoutMs: 60000, maxOutputTokens: 1024, cacheMode: 'prefix' };
}
function finalRequest(item, evidence, routes) {
  return { model: MODEL, instructions: item.mission.instructions, context: item.mission.context,
    input: { ...item.mission.input, evidence, routeDecisions: routes }, schema: item.mission.schema };
}
const finalOptions = (arm, missionId) => ({ timeoutMs: 60000, maxOutputTokens: 4096, cacheMode: 'prefix', cacheKey: `complex-v1-${missionId}-${arm}` });

export async function preflightComplexMissions(cases, options = {}) {
  const deps = await dependencies(options.dependencies), schedule = createMissionSchedule(cases);
  let largestRequestBytes = 0;
  for (const item of cases) {
    for (const arm of ARMS) {
      for (const input of item.routingInputs) {
        const result = deps.prepareAdaptiveRoute(input, { config: routingConfig(arm, item.id) });
        if (result.status !== 'preflight') fail('INVALID_MISSION_PREFLIGHT');
      }
      const result = deps.prepareStructuredRequest(finalRequest(item, Object.values(item.toolOutputs), []), finalOptions(arm, item.id));
      largestRequestBytes = Math.max(largestRequestBytes, result.requestBytes ?? 0);
    }
  }
  return { schemaVersion: 1, status: 'preflight', synthetic: true, humanValidated: false,
    datasetSha256: sha(cases), plannedWorkflows: schedule.length, distinctCases: cases.length,
    arms: ARMS, largestSynthesisRequestBytes: largestRequestBytes,
    maxRequests: options.maxRequests ?? 80, budgetUsd: options.budgetUsd ?? 5, liveMeasured: false };
}

function inferenceEvidence(result) {
  const u = result?.usage ?? {};
  return { requestedModel: [MODEL, 'openai/gpt-6-luna', 'jev-1.13.0'].includes(result?.requestedModel) ? result.requestedModel : null,
    observedModel: typeof result?.observedModel === 'string' && /^(?:openai\/gpt-6-(?:luna|astra)(?:-\d{8})?|jev-1\.13\.0)$/.test(result.observedModel) ? result.observedModel : null,
    observedProvider: result?.observedProvider === 'OpenAI' ? 'OpenAI' : null,
    observedServiceTier: ['default', 'fast', 'flex', 'priority'].includes(result?.observedServiceTier) ? result.observedServiceTier : null,
    usage: Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'].map(key => [key, number(u[key])])),
    reason: result?.reason == null ? null : safeReason(result.reason) };
}
function accountRows(rows) {
  const complete = rows.every(row => row.costComplete);
  const estimatedProviderUsd = rows.reduce((a, r) => a + (r.estimatedProviderUsd ?? 0), 0);
  const reportedProviderUsd = rows.reduce((a, r) => a + (r.reportedProviderUsd ?? 0), 0);
  return { complete, estimatedProviderUsd, reportedProviderUsd,
    accountedProviderUsd: complete ? estimatedProviderUsd + reportedProviderUsd : null };
}
function summarizeRuns(runs) {
  return ARMS.map(arm => {
    const selected = runs.filter(row => row.arm === arm), fresh = selected.filter(row => row.phase !== 'exact_repeat');
    return { arm, workflows: selected.length, correct: selected.filter(row => row.quality.passed).length,
      freshWorkflows: fresh.length, freshCorrect: fresh.filter(row => row.quality.passed).length,
      freshCoreCorrect: fresh.filter(row => row.quality.corePassed ?? row.quality.passed).length,
      freshCitationCorrect: fresh.filter(row => row.quality.citationPassed ?? row.quality.passed).length,
      routeCorrect: selected.reduce((sum, row) => sum + row.routeQuality.correct, 0),
      routeTotal: selected.reduce((sum, row) => sum + row.routeQuality.total, 0),
      inferenceRequests: selected.reduce((sum, row) => sum + row.requests, 0), exactReplays: selected.filter(row => row.cacheHit).length,
      totalLatencyMs: selected.reduce((sum, row) => sum + row.latencyMs, 0),
      accountedProviderUsd: sum(selected.map(row => row.cost.accountedProviderUsd)) };
  });
}

export async function evaluateComplexMissions(sourceCases, options = {}) {
  if (typeof options.stateDir !== 'string' || !options.stateDir) fail('STATE_DIRECTORY_REQUIRED');
  const cases = snapshot(sourceCases), deps = await dependencies(options.dependencies);
  const preflight = await preflightComplexMissions(cases, { ...options, dependencies: deps });
  const schedule = createMissionSchedule(cases);
  const meter = createInferenceBudget({ fetchImpl: options.fetchImpl ?? globalThis.fetch, budgetUsd: options.budgetUsd ?? 5, maxRequests: options.maxRequests ?? 80 });
  const report = { ...preflight, status: 'running', liveMeasured: true, startedAt: new Date().toISOString(),
    model: MODEL, reasoning: 'low', cacheMode: 'prefix', finalMaxOutputTokens: 4096,
    exactCacheTtlSeconds: 1800, runs: [], accounting: meter.summary(), requests: [], summaries: [],
    limitations: ['Synthetic expected answers; no human validation or production accuracy claim.',
      'First observed calls are not guaranteed cold. Provider prompt caches are not cleared or isolated by arm.',
      'Local evidence retrieval and structured artifacts; no browser or external action execution.',
      'Astra/Luna use OpenRouter OpenAI default; JEV uses TypeSafe direct. No automatic transport retries.',
      'All arms share exact-cache privileges; changed evidence invalidates workflow reuse.',
      'Credit charges and JEV list-price estimates exclude taxes, funding fees and host inference.'] };
  const exactCache = new Map();
  const checkpoint = async () => {
    report.accounting = meter.summary(); report.requests = meter.records(); report.summaries = summarizeRuns(report.runs);
    if (options.onCheckpoint) await options.onCheckpoint(snapshot(report));
  };
  await checkpoint();
  for (const entry of schedule) {
    if (meter.summary().blockedReason) { report.status = 'stopped'; break; }
    const start = performance.now(), firstRequest = meter.records().length;
    const { case: item, arm, phase, missionId } = entry;
    const config = routingConfig(arm, missionId);
    // Ground truth and presentation case IDs are intentionally excluded from cache identity.
    const fingerprint = sha({ mission: item.mission, routingInputs: item.routingInputs, toolOutputs: item.toolOutputs, config, final: finalOptions(arm, missionId) });
    const prior = exactCache.get(fingerprint);
    let outcome;
    if (prior && Date.now() - prior.savedAt < 1800000) {
      outcome = { ...snapshot(prior.outcome), cacheHit: true, reusedRunIndex: prior.runIndex };
    } else {
      const routing = [], evidence = [];
      for (const [index, input] of item.routingInputs.entries()) {
        const result = await deps.runAdaptiveRoute(input, { config, stateDir: options.stateDir,
          apiKeys: options.apiKeys ?? {}, fetchImpl: meter.fetchImpl });
        const selected = result.status === 'selected' && input.routes.some(route => route.id === result.routeId && route.available !== false);
        const routeId = selected ? result.routeId : null;
        const definition = selected ? input.routes.find(route => route.id === routeId) : null;
        const approval = selected ? definition.kind === 'write' || definition.requiresApproval === true : null;
        routing.push({ taskId: input.task.id, status: selected ? 'selected' : 'needs_host', routeId,
          requiresHostApproval: approval, cacheHit: result.cacheHit === true,
          reason: selected ? null : safeReason(result.reason),
          selectedProvider: ['jev', 'luna', 'astra'].includes(result.selection?.provider) ? result.selection.provider : null,
          attempts: (result.attempts ?? []).map(inferenceEvidence) });
        // A recommendation requiring approval cannot execute even a simulated write.
        if (!selected || approval || !Object.hasOwn(item.toolOutputs, routeId)) break;
        evidence.push(item.toolOutputs[routeId]);
        if (meter.summary().blockedReason) break;
      }
      if (evidence.length !== item.routingInputs.length || meter.summary().blockedReason) outcome = { status: 'routing_failed', cacheHit: false, routing, artifact: null, synthesis: null };
      else {
        const result = await deps.runStructuredRequest(finalRequest(item, evidence, routing.map(({ taskId, routeId }) => ({ taskId, routeId }))), {
          ...finalOptions(arm, missionId), apiKey: options.apiKeys?.openrouter ?? '', fetchImpl: meter.fetchImpl });
        outcome = { status: result.status === 'ok' ? 'produced' : 'synthesis_failed', cacheHit: false, routing,
          artifact: result.status === 'ok' ? result.value : null, synthesis: inferenceEvidence(result) };
        if (result.status === 'ok') exactCache.set(fingerprint, { savedAt: Date.now(), runIndex: report.runs.length + 1, outcome: snapshot(outcome) });
      }
    }
    const calls = meter.records().slice(firstRequest), quality = deps.scoreMission(outcome.artifact, item.expected);
    const expectedRoutes = item.expected.routing ?? [];
    const routeCorrect = expectedRoutes.filter((expected, index) => {
      const actual = outcome.routing[index];
      return actual?.status === 'selected' && actual.routeId === expected.routeId && actual.requiresHostApproval === expected.requiresHostApproval;
    }).length;
    report.runs.push({ index: report.runs.length + 1, missionId, variant: item.variant, phase, arm, fingerprint,
      ...outcome, routeQuality: { correct: routeCorrect, total: item.routingInputs.length }, quality,
      requests: calls.length, requestIndices: calls.map(row => row.index), cost: accountRows(calls), latencyMs: Math.max(0, performance.now() - start) });
    await checkpoint();
  }
  if (report.status === 'running') report.status = report.runs.length === schedule.length ? 'complete' : 'stopped';
  if (meter.summary().blockedReason) report.status = 'stopped';
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  return report;
}

async function boundedRead(path, limit) {
  const handle = await open(path, 'r');
  try { if ((await handle.stat()).size > limit) fail('FILE_TOO_LARGE'); return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}
async function save(path, report) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
export async function runComplexMissionCli(argv) {
  let handle;
  try {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (!['--preflight', '--live', '--env-file', '--output', '--budget-usd', '--max-requests'].includes(flag) || Object.hasOwn(options, flag)) fail('INVALID_ARGUMENTS');
      if (['--preflight', '--live'].includes(flag)) options[flag] = true;
      else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS'); options[flag] = argv[++i]; }
    }
    if (Boolean(options['--live']) === Boolean(options['--preflight'])) fail('INVALID_ARGUMENTS');
    if (options['--live'] && !options['--output']) fail('OUTPUT_REQUIRED');
    const fixturePath = fileURLToPath(new URL('./complex-missions.json', import.meta.url));
    const fixtureText = await boundedRead(fixturePath, 1000000);
    const fixture = JSON.parse(fixtureText);
    const cases = (await import('./complex-mission-cases.mjs')).buildMissionCases(fixture);
    const settings = { budgetUsd: Number(options['--budget-usd'] ?? 5), maxRequests: Number(options['--max-requests'] ?? 80) };
    createInferenceBudget(settings); // Validate limits before any file or network side effect.
    const preflight = await preflightComplexMissions(cases, settings);
    if (options['--preflight']) {
      if (options['--output'] || options['--env-file']) fail('INVALID_ARGUMENTS');
      return { exitCode: 0, result: preflight };
    }
    const env = options['--env-file'] ? parseEnv(await boundedRead(resolve(options['--env-file']), 65536)) : {};
    const apiKeys = { typesafe: process.env.TYPESAFE_API_KEY ?? env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY };
    if (Object.values(apiKeys).some(key => typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n\0]/.test(key))) fail('MISSING_API_KEY');
    const output = resolve(options['--output']); await mkdir(dirname(output), { recursive: true });
    handle = await open(output, 'wx', 0o600); await handle.writeFile(JSON.stringify(preflight, null, 2)); await handle.close(); handle = null;
    // Model state is private and excluded by .gitignore, independent from public evidence.
    const stateDir = resolve(dirname(fixturePath), '../.jev-router-complex', sha(output));
    await mkdir(stateDir, { recursive: true });
    const manifest = { ...preflight, fixtureBytesSha256: createHash('sha256').update(fixtureText).digest('hex'), frozenAt: new Date().toISOString() };
    await save(`${output}.manifest.json`, manifest);
    const report = await evaluateComplexMissions(cases, { ...settings, stateDir, apiKeys,
      onCheckpoint: report => save(output, report) });
    return { exitCode: report.status === 'complete' ? 0 : 2, result: { status: report.status, workflows: report.runs.length, accounting: report.accounting, summaries: report.summaries } };
  } catch (error) {
    if (handle) await handle.close();
    const reason = error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : /^[A-Z][A-Z_]{2,60}$/.test(error?.message ?? '') ? error.message : 'EVALUATION_FAILED';
    return { exitCode: 2, result: { status: 'needs_host', reason } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runComplexMissionCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.result, null, 2) + '\n'); process.exitCode = result.exitCode;
}
