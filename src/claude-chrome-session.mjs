import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareGoalPlan } from './goal.mjs';
import { runClaudeChromeCommand, validApiOptions } from './claude-chrome-command.mjs';
import { normalizeClaudeObservation } from './claude-observation.mjs';

// A private ledger that lets separate CLI processes share one workflow budget, deadline,
// action history and single pending action. It never executes a browser tool.
const STATE = 'session.json';
const LOCK = '.lock';
const stop = reason => ({ status: 'needs_host', reason });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
// Input problems found before any browser action or API request: nothing was consumed.
const RECOVERABLE = new Set(['INVALID_OBSERVATION', 'FRESH_OBSERVATION_REQUIRED', 'RAW_OBSERVATION_INVALID', 'READ_PAGE_INVALID',
  'READ_PAGE_UNPARSED', 'READ_PAGE_DUPLICATE_REF', 'TAB_CONTEXT_INVALID', 'TAB_NOT_FOUND', 'PAGE_TEXT_INVALID', 'OBSERVATION_INCONSISTENT',
  'TOO_MANY_CANDIDATES', 'REF_CHECK_REQUIRED']);
// Key loading and validation, and the decider's own input limits, fail before any request.
const BEFORE_REQUEST = new Set(['JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID', 'MISSING_API_KEY', 'INVALID_CONFIGURATION',
  'INPUT_TOO_LARGE', 'TOO_MANY_OPTIONS', 'INVALID_INPUT']);

// read_page does not expose field values. A value this session verified from the official form_input report
// is shown again only for the same ref, URL, field identity and page text, and only until a click is verified.
function withVerifiedInputs(observation, inputs, skipRef) {
  if (!inputs.length || !record(observation) || !Array.isArray(observation.elements) || typeof observation.text !== 'string') return observation;
  const textHash = hash(observation.text);
  return { ...observation, elements: observation.elements.map(element => {
    if (!record(element) || element.value !== undefined || element.ref === skipRef) return element;
    const known = inputs.find(item => item.ref === element.ref && item.url === observation.tab?.url && item.role === element.role
      && item.name === element.name && item.description === (element.description ?? null) && item.textHash === textHash);
    // Marked as reported by the input tool: shown to JEV, never used as page evidence.
    return known ? { ...element, value: known.value, valueSource: 'tool_report' } : element;
  }) };
}

// Lock creation publishes the owner record atomically (hard link of a complete file), so a crash cannot leave
// an anonymous lock. Filesystems without hard links fall back to exclusive create plus write.
async function acquireLock(lockPath, owner) {
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(owner); } finally { await file.close(); }
    try { await link(temporary, lockPath); return; }
    catch (error) { if (['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
    const lock = await open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(owner); }
    catch (failure) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw failure; }
    await lock.close();
  } finally { await unlink(temporary).catch(() => {}); }
}

async function releaseLock(lockPath) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try { await unlink(lockPath); return true; }
    catch (error) { if (error.code === 'ENOENT') return true; if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false; await pause(attempt * 5); }
  }
  return false;
}

function preparedPlan(plan) {
  const prepared = prepareGoalPlan(plan);
  return prepared?.allowedOrigins && prepared.actions.every(action => ['click', 'typeText'].includes(action.action)) ? prepared : null;
}

async function save(directory, state) {
  const temporary = join(directory, `${STATE}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync(); } finally { await file.close(); }
    // Windows refuses to replace a file that another process (status, antivirus, sync) has open; retry briefly.
    for (let attempt = 1; ; attempt++) {
      try { return await rename(temporary, join(directory, STATE)); }
      catch (error) { if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await pause(attempt * 5); }
    }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

// A missing or malformed ledger is SESSION_INVALID; any other read failure is thrown and reported as an I/O error.
async function load(directory) {
  let text, state;
  try { text = await readFile(join(directory, STATE), 'utf8'); }
  catch (error) { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  try { state = JSON.parse(text); } catch { return null; }
  if (record(state) && state.inputs === undefined) state.inputs = []; // Early ledgers had no remembered inputs.
  const plan = record(state) ? preparedPlan(state.plan) : null;
  if (!plan || state.version !== 1 || state.planHash !== hash(plan) || !['active', 'completed', 'needs_host'].includes(state.status)
      || ![state.calls, state.maxCalls, state.createdAtEpochMs, state.deadlineEpochMs].every(count) || state.calls > state.maxCalls
      || !Array.isArray(state.history) || !Array.isArray(state.inputs) || !(state.pending === null || ['proposed', 'authorized'].includes(state.pending?.stage))
      || !record(state.usage) || !validApiOptions(state.api)) return null;
  return { state, plan };
}

async function lockOwner(directory) {
  try { const owner = JSON.parse(await readFile(join(directory, LOCK), 'utf8')); return record(owner) ? owner : { unknown: true }; }
  catch (error) { return error.code === 'ENOENT' ? null : { unknown: true }; }
}

function summary(state, epoch) {
  // Each POST is counted before it is sent; one whose usage was never recorded (in flight or interrupted) has unknown cost.
  const { usage } = state, unsettled = state.calls !== usage.requests;
  return { status: state.status, ...(state.reason ? { reason: state.reason } : {}), calls: state.calls, maxCalls: state.maxCalls,
    remainingMs: Math.max(0, state.deadlineEpochMs - epoch), history: state.history, pending: state.pending?.stage ?? null,
    usage: { requests: usage.requests, knownInputTokens: usage.knownInputTokens, knownUsageUsd: usage.knownUsageUsd,
      estimatedJevUsd: usage.unknown || unsettled ? null : usage.knownUsageUsd } };
}

/** Creates a new exclusive session directory. An existing directory is never reused or merged. */
export async function startClaudeChromeSession(input, { sessionDir, now = Date.now } = {}) {
  if (typeof sessionDir !== 'string' || !sessionDir.trim()) return stop('INVALID_ARGUMENTS');
  const plan = preparedPlan(input?.plan);
  if (!plan) return stop('INVALID_PLAN');
  const maxCalls = input.maxCalls ?? Math.min(50, plan.maxSteps + 3), api = input.api ?? {};
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) return stop('INVALID_MAX_CALLS');
  if (!validApiOptions(api)) return stop('INVALID_API_OPTIONS');
  const directory = resolve(sessionDir), epoch = now();
  await mkdir(dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') return stop('SESSION_EXISTS'); throw error; }
  const state = { version: 1, plan: input.plan, planHash: hash(plan), maxCalls, api, createdAtEpochMs: epoch,
    deadlineEpochMs: Math.ceil(epoch + plan.maxDurationMs), status: 'active', calls: 0, history: [], inputs: [], pending: null,
    usage: { requests: 0, knownInputTokens: 0, knownUsageUsd: 0, unknown: false } };
  await save(directory, state);
  return { status: 'started', session: summary(state, epoch) };
}

/**
 * Explicit host recovery after a killed command: removes the lock only when it names this pid and that
 * process no longer exists. It is never called automatically.
 */
export async function unlockClaudeChromeSession({ sessionDir, pid, now = Date.now } = {}) {
  if (typeof sessionDir !== 'string' || !sessionDir.trim() || !Number.isSafeInteger(pid) || pid < 0) return stop('INVALID_ARGUMENTS');
  const directory = resolve(sessionDir), lockPath = join(directory, LOCK);
  let raw, owner, age;
  try {
    raw = await readFile(lockPath, 'utf8');
    try { owner = JSON.parse(raw); } catch { owner = undefined; }
    if (!record(owner) || !Number.isSafeInteger(owner.pid)) owner = { unknown: true };
    age = now() - (await lstat(lockPath)).mtimeMs;
  } catch (error) { return error.code === 'ENOENT' ? stop('NOT_LOCKED') : stop('LOCK_UNREADABLE'); }
  if (owner.unknown) {
    // An ownerless lock (left by an older release) is released only with --pid 0 and only once no command
    // could still hold it: every command finishes within a few minutes.
    if (pid !== 0 || age < 600000) return { ...stop('LOCK_OWNER_UNKNOWN'), locked: owner, ageMs: Math.max(0, Math.round(age)) };
  } else {
    if (owner.pid !== pid) return { ...stop('LOCK_OWNER_MISMATCH'), locked: owner };
    try { process.kill(pid, 0); return { ...stop('LOCK_OWNER_RUNNING'), locked: owner }; }
    catch (error) { if (error.code !== 'ESRCH') return { ...stop('LOCK_OWNER_RUNNING'), locked: owner }; }
  }
  // Remove only the lock that was inspected; a newer owner's lock is left alone.
  let current;
  try { current = await readFile(lockPath, 'utf8'); } catch { return stop('NOT_LOCKED'); }
  if (current !== raw) return { ...stop('LOCK_OWNER_MISMATCH'), locked: await lockOwner(directory) };
  // One attempt only: retrying by path could remove a lock that a new owner created in the meantime.
  try { await unlink(lockPath); } catch (error) { return error.code === 'ENOENT' ? stop('NOT_LOCKED') : stop('LOCK_RELEASE_FAILED'); }
  return { status: 'unlocked', removed: owner };
}

/** decide / authorize / verify against the ledger; status is read-only. */
export async function runClaudeChromeSession(command, input = {}, { sessionDir, envFile, apiKey = '', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof sessionDir !== 'string' || !sessionDir.trim() || !['decide', 'authorize', 'verify', 'status'].includes(command)) return stop('INVALID_ARGUMENTS');
  const directory = resolve(sessionDir);
  if (command === 'status') {
    try {
      const loaded = await load(directory);
      return loaded ? { status: 'session', session: { ...summary(loaded.state, now()), locked: await lockOwner(directory) } } : stop('SESSION_INVALID');
    } catch { return stop('SESSION_IO_ERROR'); }
  }
  const keys = ['raw', 'observation', ...(command === 'verify' ? ['toolResult', 'toolResultAtEpochMs'] : [])];
  if (!record(input) || Object.keys(input).some(key => !keys.includes(key))
      || (input.toolResultAtEpochMs !== undefined && !count(input.toolResultAtEpochMs))) return stop('INVALID_ARGUMENTS');
  const lockPath = join(directory, LOCK);
  try { await acquireLock(lockPath, JSON.stringify({ pid: process.pid, command, sinceEpochMs: Date.now() })); }
  catch (error) {
    if (['EEXIST', 'EPERM'].includes(error.code)) return { ...stop('SESSION_BUSY'), locked: await lockOwner(directory) };
    if (error.code === 'ENOENT') return stop('SESSION_NOT_FOUND');
    return stop('SESSION_IO_ERROR');
  }
  let result;
  try {
    // Awaited inside try so the lock is held until every save has settled.
    result = await locked();
  } catch {
    // A ledger read/write failure after work started: report it without internal details. A request that
    // was already counted stays counted, and its cost is reported as unknown by status.
    result = stop('SESSION_IO_ERROR');
  } finally {
    if (!await releaseLock(lockPath) && result) result = { ...result, lockReleaseFailed: true };
  }
  return result;

  async function locked() {
    const loaded = await load(directory);
    if (!loaded) return stop('SESSION_INVALID');
    const { state } = loaded, epoch = now();
    const finish = async (result, persist = true) => { if (persist) await save(directory, state); return { ...result, session: summary(state, now()) }; };
    const halt = async (reason, result = stop(reason)) => { state.status = 'needs_host'; state.reason = result.reason; return await finish(result); };
    if (state.status !== 'active') return await finish(stop(state.status === 'completed' ? 'SESSION_COMPLETED' : 'SESSION_STOPPED'), false);
    if (epoch >= state.deadlineEpochMs) return await halt('TIMEOUT');
    if ((input.raw === undefined) === (input.observation === undefined)) return await finish(stop('INVALID_OBSERVATION'), false);
    const normalized = input.raw !== undefined ? normalizeClaudeObservation(input.raw, { now: () => epoch }) : { status: 'observed', observation: input.observation };
    if (normalized.status !== 'observed') return await finish(normalized, false);
    const pendingAction = state.pending?.stage === 'authorized' ? loaded.plan.actions.find(action => action.id === state.pending.authorization?.proposal?.actionId) : undefined;
    // The field being verified must be judged from fresh evidence, never from its remembered value.
    const skipRef = command === 'verify' && pendingAction?.action === 'typeText' ? state.pending.authorization.proposal.target?.ref : undefined;
    // Raw input keeps its ref binding check after this ledger adds remembered values.
    const observation = { observation: withVerifiedInputs(normalized.observation, state.inputs, skipRef),
      ...(input.raw !== undefined ? { refCheck: record(input.raw) ? input.raw.refCheck ?? null : null } : {}) };

    if (command === 'decide') {
      if (state.pending?.stage === 'authorized') return await finish(stop('ACTION_UNVERIFIED'), false);
      if (state.calls >= state.maxCalls) return await halt('CALL_BUDGET_EXHAUSTED');
      const before = state.calls;
      let counting, ledgerWriteFailed = false;
      // Count and persist every actual POST before it is sent; an interrupted process still used budget.
      const counted = async (...args) => {
        if (state.calls >= state.maxCalls) throw new Error('CALL_BUDGET_EXHAUSTED');
        state.calls++;
        counting = save(directory, state);
        try { await counting; } catch { state.calls--; ledgerWriteFailed = true; throw new Error('LEDGER_WRITE_FAILED'); }
        return fetchImpl(...args);
      };
      const result = await runClaudeChromeCommand('decide', { plan: state.plan, history: state.history, api: state.api, ...observation },
        { envFile, apiKey, fetchImpl: counted, now });
      // A decider timeout can return while the pre-request save is still being written; never let it land later.
      await counting?.catch(() => {});
      if (ledgerWriteFailed) return await finish(stop('LEDGER_WRITE_FAILED'), false);
      const { cost } = result;
      if (cost) {
        state.usage.requests += cost.calls ?? 0;
        state.usage.knownInputTokens += cost.knownInputTokens ?? 0;
        state.usage.knownUsageUsd += cost.knownUsageUsd ?? 0;
        state.usage.unknown ||= !cost.complete;
      }
      if (result.status === 'proposed') { state.pending = { stage: 'proposed', proposal: result.proposal }; return await finish(result); }
      // With no request sent, observation-input, key and request-size problems change nothing.
      if (state.calls === before && !result.requests?.length && (RECOVERABLE.has(result.reason) || BEFORE_REQUEST.has(result.reason))) return await finish(result, false);
      return await halt(result.reason, result);
    }

    if (command === 'authorize') {
      if (state.pending?.stage !== 'proposed') return await finish(stop(state.pending ? 'ACTION_UNVERIFIED' : 'NO_PENDING_PROPOSAL'), false);
      const result = await runClaudeChromeCommand('authorize', { plan: state.plan, proposal: state.pending.proposal, ...observation }, { now });
      if (result.status === 'authorized') { state.pending = { stage: 'authorized', authorization: result }; return await finish(result); }
      if (result.status === 'completed') { state.pending = null; state.status = 'completed'; return await finish(result); }
      if (RECOVERABLE.has(result.reason)) return await finish(result, false);
      state.pending = null;
      // Nothing ran: an expired proposal is discarded and the host may observe and decide again within budget.
      if (result.reason === 'PROPOSAL_EXPIRED') return await finish(result);
      return await halt(result.reason, result);
    }

    if (state.pending?.stage !== 'authorized') return await finish(stop('NO_PENDING_ACTION'), false);
    const result = await runClaudeChromeCommand('verify', { plan: state.plan, authorization: state.pending.authorization, ...observation,
      ...(input.toolResult !== undefined ? { toolResult: input.toolResult } : {}),
      ...(input.toolResultAtEpochMs !== undefined ? { toolResultAtEpochMs: input.toolResultAtEpochMs } : {}) }, { now });
    if (result.status === 'observed_after_action') {
      const { target } = state.pending.authorization.proposal;
      if (pendingAction.action === 'click') state.inputs = [];
      else {
        state.inputs = state.inputs.filter(item => item.ref !== target.ref);
        // Remember the field as observed now, which may be value-named, together with the page text it belongs to.
        const seen = observation.observation.elements.find(element => element.ref === target.ref) ?? target;
        if (result.inputEvidence === 'tool_report') state.inputs.push({ ref: target.ref, url: result.url, role: seen.role, name: seen.name,
          description: seen.description ?? null, textHash: hash(observation.observation.text), value: pendingAction.text });
      }
      state.history.push(result.historyEntry); state.pending = null;
      return await finish(result);
    }
    if (RECOVERABLE.has(result.reason)) return await finish(result, false);
    // The action may have happened; keep its authorization for review and never replay it.
    state.pending.outcome = 'unverified';
    return await halt(result.reason, result);
  }
}
