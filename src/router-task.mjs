import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, link } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareRouteRequest, decideRoute } from './router.mjs';
import { loadApiKey } from './config.mjs';
import { createMeteredFetch, summarizeBilling } from './meter.mjs';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobKey = (snapshot, config) => hash([snapshot.task.id, snapshot.task.revision, config.mode]);
const fingerprint = (snapshot, config) => hash({ snapshot, config });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const finite = x => Number.isFinite(x) && x >= 0;
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = reason => { throw new Error(reason); };
const emptyCost = () => summarizeBilling(createMeteredFetch().stats());
const unknownCost = () => ({ ...emptyCost(), calls: 1, inputTokens: null, outputTokens: null,
  requestBytes: null, questionCount: null, estimatedJevUsd: null, complete: false });
const resultKeys = ['status', 'mode', 'taskId', 'revision', 'recommendationId', 'effectiveRouteId',
  'requiresHostApproval', 'recommendationRequiresHostApproval', 'reason', 'confidence', 'margin', 'model',
  'latencyMs', 'cost', 'requests', 'decisionCost', 'decisionRequests', 'replayed'];

function base(prepared) {
  const cost = emptyCost();
  return { status: 'needs_host', mode: prepared?.config?.mode ?? null,
    taskId: prepared?.snapshot?.task.id ?? null, revision: prepared?.snapshot?.task.revision ?? null,
    recommendationId: null, effectiveRouteId: null, requiresHostApproval: false,
    recommendationRequiresHostApproval: false, latencyMs: 0,
    cost, requests: [], decisionCost: cost, decisionRequests: [], replayed: false };
}

function validateCost(cost) {
  const statsKeys = ['calls', 'pendingRequests', 'pendingUsage', 'errors', 'inputTokens', 'outputTokens',
    'knownInputTokens', 'knownOutputTokens', 'inputUsageCalls', 'outputUsageCalls', 'requestBytes',
    'knownRequestBytes', 'questionCount', 'lastLatencyMs'];
  const template = emptyCost();
  if (!exact(cost, Object.keys(template)) || Object.keys(cost).length !== Object.keys(template).length) return false;
  for (const key of statsKeys) {
    if (key === 'lastLatencyMs') { if (cost[key] !== null && !finite(cost[key])) return false; }
    else if (['inputTokens', 'outputTokens', 'knownInputTokens', 'knownOutputTokens', 'requestBytes', 'knownRequestBytes', 'questionCount'].includes(key)) {
      if (cost[key] !== null && !count(cost[key])) return false;
    } else if (!count(cost[key])) return false;
  }
  if (cost.calls !== 1 || ['pendingRequests', 'pendingUsage', 'errors', 'inputUsageCalls', 'outputUsageCalls'].some(key => cost[key] > 1)) return false;
  const stats = Object.fromEntries(statsKeys.map(key => [key, cost[key]]));
  const recomputed = summarizeBilling(stats);
  // Older valid ledgers retain the date on which their original list price was verified.
  recomputed.pricingVerifiedOn = cost.pricingVerifiedOn;
  if (typeof cost.pricingVerifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cost.pricingVerifiedOn)) return false;
  return Object.keys(cost).every(key => equal(cost[key], recomputed[key]));
}

function validateRequests(requests) {
  const keys = ['index', 'model', 'httpStatus', 'latencyMs', 'usageLatencyMs', 'inputTokens', 'outputTokens',
    'requestBytes', 'questionCount', 'responsePending', 'usagePending', 'usageParsed', 'error'];
  if (!Array.isArray(requests) || requests.length !== 1) return false;
  const item = requests[0];
  return exact(item, keys) && Object.keys(item).length === keys.length && item.index === 1
    && (item.model === null || typeof item.model === 'string' && /^jev(?:-[A-Za-z0-9._-]{1,64})?$/.test(item.model))
    && (item.httpStatus === null || count(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599)
    && ['latencyMs', 'usageLatencyMs'].every(key => item[key] === null || finite(item[key]))
    && ['inputTokens', 'outputTokens', 'requestBytes', 'questionCount'].every(key => item[key] === null || count(item[key]))
    && ['responsePending', 'usagePending', 'usageParsed'].every(key => typeof item[key] === 'boolean')
    && [null, 'HTTP_ERROR', 'TRANSPORT_FAILED'].includes(item.error);
}

function consistentBilling(cost, [request]) {
  const expected = {
    calls: 1, pendingRequests: Number(request.responsePending), pendingUsage: Number(request.usagePending),
    errors: Number(request.error !== null), inputTokens: request.inputTokens, outputTokens: request.outputTokens,
    knownInputTokens: request.inputTokens ?? 0, knownOutputTokens: request.outputTokens ?? 0,
    inputUsageCalls: Number(request.inputTokens !== null), outputUsageCalls: Number(request.outputTokens !== null),
    requestBytes: request.requestBytes, knownRequestBytes: request.requestBytes ?? 0,
    questionCount: request.questionCount, lastLatencyMs: request.latencyMs,
  };
  return Object.keys(expected).every(key => cost[key] === expected[key]);
}

function handoffFor(job, key) {
  return { schemaVersion: 1, stateRecordKey: key, fingerprint: job.fingerprint,
    task: job.snapshot.task, route: job.snapshot.routes.find(route => route.id === job.result.recommendationId),
    executionStatus: 'not_started', requiresFreshHostValidation: true };
}

function validCompleted(job, key) {
  const r = job.result;
  if (!exact(r, resultKeys) || !['ready', 'shadow', 'review_required', 'needs_host'].includes(r.status)
      || r.mode !== job.mode || r.taskId !== job.snapshot.task.id || r.revision !== job.snapshot.task.revision
      || r.replayed !== false || !finite(r.latencyMs) || !validateCost(r.cost) || !validateRequests(r.requests)
      || !consistentBilling(r.cost, r.requests)
      || !equal(r.cost, r.decisionCost) || !equal(r.requests, r.decisionRequests)) return false;
  if (['confidence', 'margin'].some(key => r[key] !== undefined && (!finite(r[key]) || r[key] > 1))) return false;
  if (r.model !== undefined && (typeof r.model !== 'string' || !/^jev-[A-Za-z0-9._-]{1,64}$/.test(r.model))) return false;
  if (r.status === 'needs_host') return typeof r.reason === 'string' && /^[A-Z_]{1,64}$/.test(r.reason)
    && r.recommendationId === null && r.effectiveRouteId === null
    && r.requiresHostApproval === false && r.recommendationRequiresHostApproval === false && job.handoff === undefined;
  const selected = job.snapshot.routes.find(route => route.id === r.recommendationId && route.available);
  const effective = job.snapshot.routes.find(route => route.id === r.effectiveRouteId && route.available);
  if (!selected || !effective || r.requiresHostApproval !== effective.requiresApproval
      || r.recommendationRequiresHostApproval !== selected.requiresApproval || r.reason !== undefined
      || !finite(r.confidence) || r.confidence < job.config.minConfidence
      || !finite(r.margin) || r.margin < job.config.minMargin || !r.model) return false;
  const expectedStatus = job.mode === 'shadow' ? 'shadow' : selected.requiresApproval ? 'review_required' : 'ready';
  if (r.status !== expectedStatus || effective.id !== (job.mode === 'shadow' ? job.snapshot.baselineRouteId : selected.id)) return false;
  return r.status === 'ready' ? equal(job.handoff, handoffFor(job, key)) : job.handoff === undefined;
}

function validateState(state) {
  if (!exact(state, ['schemaVersion', 'attemptedCalls', 'jobs']) || state.schemaVersion !== 1
      || !count(state.attemptedCalls) || state.attemptedCalls > 10000 || !record(state.jobs)) fail('STATE_INVALID');
  const jobs = Object.entries(state.jobs);
  if (jobs.length !== state.attemptedCalls) fail('STATE_INVALID');
  for (const [key, job] of jobs) {
    if (!isHash(key) || !exact(job, ['state', 'mode', 'fingerprint', 'snapshot', 'config', 'result', 'handoff'])
        || !['pending', 'completed'].includes(job.state) || !['active', 'shadow'].includes(job.mode)
        || !isHash(job.fingerprint)) fail('STATE_INVALID');
    const prepared = prepareRouteRequest(job.snapshot, job.config);
    if (prepared.status !== 'prepared' || !prepared.config.enabled || prepared.config.mode !== job.mode
        || !equal(prepared.snapshot, job.snapshot) || !equal(prepared.config, job.config)
        || jobKey(job.snapshot, job.config) !== key || fingerprint(job.snapshot, job.config) !== job.fingerprint) fail('STATE_INVALID');
    if (job.state === 'pending' ? job.result !== undefined || job.handoff !== undefined : !validCompleted(job, key)) fail('STATE_INVALID');
  }
  return state;
}

async function boundedRead(path, maximum = MAX_STATE_BYTES) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('STATE_INVALID');
  const file = await open(path, 'r');
  try {
    const data = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maximum) fail('STATE_INVALID');
    return data.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

async function readState(path) {
  try { return validateState(JSON.parse(await boundedRead(path))); }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, attemptedCalls: 0, jobs: {} };
    fail('STATE_INVALID');
  }
}

async function atomicState(path, state) {
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) fail('STATE_CAPACITY_EXCEEDED');
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600); await file.writeFile(serialized); await file.sync();
    await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}

async function materialize(stateDir, job, key) {
  const directory = join(stateDir, 'handoffs');
  const path = join(directory, `${key}-${job.fingerprint}.json`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('HANDOFF_WRITE_FAILED');
    const expected = JSON.stringify(handoffFor(job, key), null, 2) + '\n';
    // The ledger has already committed. Existing files are never silently overwritten.
    try {
      const actual = await boundedRead(path);
      if (actual !== expected) fail('HANDOFF_MISMATCH');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = `${path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temporary, 'wx', 0o600); await file.writeFile(expected); await file.sync();
        await file.close(); file = null;
        // Exclusive atomic publication: a crash while writing cannot leave a partial final handoff.
        try { await link(temporary, path); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await boundedRead(path) !== expected) fail('HANDOFF_MISMATCH');
        }
      } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }
    return path;
  } catch (error) { fail(error.message === 'HANDOFF_MISMATCH' ? 'HANDOFF_MISMATCH' : 'HANDOFF_WRITE_FAILED'); }
}

/** One bounded routing decision with process-crash persistence; never executes a route. */
export async function runRoutingTask(input, { config = {}, stateDir, envFile, apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const prepared = prepareRouteRequest(input, config);
  if (prepared.status !== 'prepared') return { ...base(), reason: prepared.reason };
  const { snapshot, config: settings } = prepared;
  const initial = base(prepared);
  const baseline = snapshot.routes.find(route => route.id === snapshot.baselineRouteId);
  if (!settings.enabled) return { ...initial, status: 'bypassed', effectiveRouteId: baseline.id, requiresHostApproval: baseline.requiresApproval };
  if (settings.mode === 'dry-run') return { ...initial, status: 'dry_run', eligibleRouteIds: prepared.eligibleRouteIds, requestBytes: Buffer.byteLength(prepared.body) };
  if (typeof stateDir !== 'string' || !stateDir.trim()) return { ...initial, reason: 'STATE_DIR_REQUIRED' };
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey) || typeof fetchImpl !== 'function') return { ...initial, reason: 'INVALID_CONFIGURATION' };
  let lock, lockPath, state, current = initial, ownsLock = false;
  const budget = () => ({ attemptedCalls: state?.attemptedCalls ?? null, maxCalls: settings.maxCalls });
  try {
    const directory = resolve(stateDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STATE_INVALID');
    lockPath = join(directory, '.lock');
    try { lock = await open(lockPath, 'wx', 0o600); ownsLock = true; }
    catch (error) { if (error.code === 'EEXIST') fail('STATE_BUSY'); throw error; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const statePath = join(directory, 'state.json');
    state = await readState(statePath);
    const key = jobKey(snapshot, settings), digest = fingerprint(snapshot, settings);
    const previous = state.jobs[key];
    if (previous) {
      if (previous.fingerprint !== digest) fail('TASK_REVISION_CONFLICT');
      if (previous.state === 'pending') return { ...initial, reason: 'TASK_OUTCOME_UNKNOWN', decisionCost: unknownCost(), budget: budget() };
      current = { ...previous.result, replayed: true, cost: emptyCost(), requests: [] };
      if (previous.handoff) current = { ...current, handoffPath: await materialize(directory, previous, key) };
      return { ...current, budget: budget() };
    }
    if (state.attemptedCalls >= settings.maxCalls) fail('CALL_BUDGET_EXHAUSTED');
    // Replay needs no key. New decisions validate local prerequisites before reserving a paid attempt.
    const keyValue = await loadApiKey({ apiKey, envFile });
    if (!keyValue) fail('MISSING_API_KEY');
    if (/[\r\n]/.test(keyValue)) fail('INVALID_CONFIGURATION');
    const meter = createMeteredFetch({ fetchImpl });
    const job = { state: 'pending', mode: settings.mode, fingerprint: digest, snapshot, config: settings };
    state.jobs[key] = job; state.attemptedCalls++;
    await atomicState(statePath, state);
    const decision = await decideRoute(snapshot, { config: settings, apiKey: keyValue, fetchImpl: meter.fetchImpl });
    const cost = summarizeBilling(await meter.flush({ timeoutMs: 100 })), requests = meter.records();
    current = { ...initial, latencyMs: decision.latencyMs ?? 0, cost, requests, decisionCost: cost, decisionRequests: requests };
    for (const metric of ['confidence', 'margin', 'model']) if (decision[metric] !== undefined) current[metric] = decision[metric];
    if (decision.status === 'selected') {
      const chosen = snapshot.routes.find(route => route.id === decision.routeId);
      const effective = settings.mode === 'shadow' ? baseline : chosen;
      current = { ...current, status: settings.mode === 'shadow' ? 'shadow' : chosen.requiresApproval ? 'review_required' : 'ready',
        recommendationId: chosen.id, effectiveRouteId: effective.id, requiresHostApproval: effective.requiresApproval,
        recommendationRequiresHostApproval: chosen.requiresApproval };
    } else current.reason = decision.reason ?? 'INVALID_RESPONSE';
    job.state = 'completed'; job.result = current;
    if (current.status === 'ready') job.handoff = handoffFor(job, key);
    // Commit the paid result first. A missing handoff can then be recreated without a second call.
    await atomicState(statePath, state);
    if (job.handoff) current = { ...current, handoffPath: await materialize(directory, job, key) };
    return { ...current, budget: budget() };
  } catch (error) {
    const known = new Set(['STATE_INVALID', 'STATE_BUSY', 'TASK_REVISION_CONFLICT', 'STATE_CAPACITY_EXCEEDED',
      'CALL_BUDGET_EXHAUSTED', 'JEV_CONFIG_READ_ERROR', 'MISSING_API_KEY', 'INVALID_CONFIGURATION',
      'HANDOFF_WRITE_FAILED', 'HANDOFF_MISMATCH']);
    const { handoffPath: _discard, ...safe } = current;
    return { ...safe, status: 'needs_host', effectiveRouteId: null, requiresHostApproval: false,
      reason: known.has(error.message) ? error.message : 'STATE_IO_ERROR', budget: budget() };
  } finally {
    await lock?.close().catch(() => {});
    if (ownsLock) await unlink(lockPath).catch(() => {});
  }
}

function freezeTree(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

async function checkNoWriter(directory) {
  try { await lstat(join(directory, '.lock')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('STATE_BUSY');
}

/** Offline snapshot verification only. Never creates, repairs, claims or executes work. */
export async function readReadyHandoff(currentInput, { config = {}, stateDir } = {}) {
  const prepared = prepareRouteRequest(currentInput, config);
  if (prepared.status !== 'prepared') return { status: 'needs_host', reason: prepared.reason };
  const { snapshot, config: settings } = prepared;
  if (!settings.enabled || settings.mode !== 'active') return { status: 'needs_host', reason: 'HANDOFF_REQUIRES_ACTIVE' };
  if (typeof stateDir !== 'string' || !stateDir.trim()) return { status: 'needs_host', reason: 'STATE_DIR_REQUIRED' };
  try {
    const directory = resolve(stateDir);
    let directoryStat;
    try { directoryStat = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') fail('TASK_NOT_FOUND'); throw error; }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('STATE_INVALID');
    await checkNoWriter(directory);
    const state = await readState(join(directory, 'state.json'));
    if (Object.values(state.jobs).some(job => job.snapshot.task.id === snapshot.task.id
        && job.snapshot.task.revision > snapshot.task.revision)) fail('STALE_TASK_REVISION');
    const key = jobKey(snapshot, settings), digest = fingerprint(snapshot, settings);
    const job = state.jobs[key];
    if (!job) fail('TASK_NOT_FOUND');
    if (job.fingerprint !== digest) fail('TASK_REVISION_CONFLICT');
    if (job.state === 'pending') fail('TASK_OUTCOME_UNKNOWN');
    if (job.result.status !== 'ready' || !job.handoff) fail('HANDOFF_NOT_READY');
    const handoff = handoffFor(job, key);
    const directoryPath = join(directory, 'handoffs');
    const path = join(directoryPath, `${key}-${digest}.json`);
    try {
      const stat = await lstat(directoryPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('HANDOFF_MISMATCH');
      if (await boundedRead(path) !== JSON.stringify(handoff, null, 2) + '\n') fail('HANDOFF_MISMATCH');
    } catch (error) {
      fail(error.code === 'ENOENT' ? 'HANDOFF_NOT_FOUND' : 'HANDOFF_MISMATCH');
    }
    // An atomic ledger snapshot is immutable to normal writers. A reader grants no lease;
    // availability/permission still need the host's fresh checks immediately before use.
    await checkNoWriter(directory);
    return freezeTree({ status: 'handoff_ready', handoff,
      requiresFreshHostValidation: true, executionClaimed: false, replayed: true,
      cost: emptyCost(), requests: [], decisionCost: job.result.decisionCost,
      decisionRequests: job.result.decisionRequests,
      budget: { attemptedCalls: state.attemptedCalls, maxCalls: settings.maxCalls } });
  } catch (error) {
    const known = ['STATE_INVALID', 'STATE_BUSY', 'TASK_NOT_FOUND', 'TASK_REVISION_CONFLICT', 'STALE_TASK_REVISION',
      'TASK_OUTCOME_UNKNOWN', 'HANDOFF_NOT_READY', 'HANDOFF_NOT_FOUND', 'HANDOFF_MISMATCH'];
    return { status: 'needs_host', reason: known.includes(error.message) ? error.message : 'STATE_IO_ERROR' };
  }
}
