import { parseAX, activeTargets, isProtectedElement, safeAdapterError } from './cua.mjs';
import { prepareGoalActions, matchesActionTarget } from './decider.mjs';
import { resolveStableTarget } from './observation.mjs';

const now = () => performance.now();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'string' && Boolean(value.trim());
const safeReason = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const protectedRole = element => element.protected === true || isProtectedElement(element) || /secure|password|protected/i.test(element.role);
const fingerprint = observation => JSON.stringify([observation.url, observation.title, observation.text, observation.elements]);
// DOM refs and unrelated body text can drift without the requested operation
// doing anything. Stable structured targets provide a narrower progress signal;
// text-only completion is still independently checked by the host contract.
const progressFingerprint = observation => observation.elements.every(element => positive(element.identity))
  ? JSON.stringify([observation.url, observation.title, observation.elements.map(element => {
    const { ref, ...semantic } = element;
    return JSON.stringify(semantic);
  }).sort()]) : fingerprint(observation);
const originOf = url => { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null; } catch { return null; } };
function safeDecisionDiagnostics(value, actions, elements) {
  if (!record(value) || !['OPERATION', 'TARGET'].includes(value.head)
    || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !Number.isFinite(value.margin) || value.margin < 0 || value.margin > 1) return undefined;
  const knownChoice = value.head === 'OPERATION'
    ? ['DONE', 'BLOCKED'].includes(value.choice) || actions.some(action => action.id === value.choice)
    : value.choice === 'NONE' || elements.some(element => `e_${element.ref}` === value.choice);
  if (!knownChoice) return undefined;
  return { head: value.head, choice: value.choice, confidence: value.confidence, margin: value.margin };
}

export function prepareGoalPlan(options = {}) {
  try {
    const { goal, actions, completion, maxSteps = 12, maxDurationMs = 60000, verificationTimeoutMs = Math.min(1000, maxDurationMs), maxStaleReplans = 0, allowedOrigins } = options;
    const preparedActions = prepareGoalActions(actions);
    if (!positive(goal) || !preparedActions || !record(completion)
      || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100
      || !Number.isSafeInteger(maxStaleReplans) || maxStaleReplans < 0 || maxStaleReplans > 2
      || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 1200000
      || !Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs < 0 || verificationTimeoutMs > maxDurationMs) return null;
    const copied = {};
    for (const [key, value] of Object.entries(completion)) {
      if (key === 'urlIncludes') { if (!positive(value)) return null; copied[key] = value; }
      else if (['textIncludes', 'textExcludes'].includes(key)) {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || list.length > 20 || !list.every(positive)) return null;
        copied[key] = Object.freeze([...list]);
      } else return null;
    }
    if (!copied.textIncludes && !copied.urlIncludes) return null;
    let origins;
    if (allowedOrigins !== undefined) {
      if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || !allowedOrigins.every(x => originOf(x) === x)) return null;
      origins = Object.freeze([...new Set(allowedOrigins)]);
    }
    return Object.freeze({ goal, actions: preparedActions, completion: Object.freeze(copied), maxSteps, maxDurationMs, verificationTimeoutMs, maxStaleReplans, ...(origins ? { allowedOrigins: origins } : {}) });
  } catch { return null; }
}

export function goalCompletionMatches(observation, completion) {
  return (!completion.textIncludes || completion.textIncludes.every(value => observation.text.includes(value)))
    && (!completion.textExcludes || completion.textExcludes.every(value => !observation.text.includes(value)))
    && (!completion.urlIncludes || (typeof observation.url === 'string' && observation.url.includes(completion.urlIncludes)));
}

/** Bounded local loop. The model selects only host-authored action IDs and observed refs. */
export async function runGoalWorkflow(options = {}) {
  const started = now(), steps = [], history = [], replans = [];
  const metrics = { observations: 0, observationMs: 0, decisions: 0, decisionMs: 0, actions: 0, actionMs: 0, staleReplans: 0 };
  let completedSteps = 0;
  const finish = (reason, detail, diagnostics) => ({ status: reason ? 'needs_host' : 'completed', ...(reason ? { reason } : {}),
    ...(safeReason(detail) ? { detail } : {}), ...(diagnostics ? { diagnostics } : {}),
    completedSteps, steps, replans, metrics, durationMs: Math.max(0, now() - started) });
  const plan = prepareGoalPlan(options), { target, decider, signal } = options;
  if (!plan || !target || (typeof target.getObservation !== 'function' && typeof target.getAXState !== 'function')
    || typeof decider?.decide !== 'function' || plan.actions.some(a => typeof target[a.action] !== 'function')) return finish('INVALID_PLAN');
  if (activeTargets.has(target)) return finish('TARGET_BUSY');
  activeTargets.add(target);
  const deadline = started + plan.maxDurationMs;
  const boundary = after => signal?.aborted ? (after ? 'ABORTED_AFTER_ACTION' : 'ABORTED')
    : now() >= deadline ? (after ? 'TIMEOUT_AFTER_ACTION' : 'TIMEOUT') : undefined;
  const pendingReads = new Set();
  const bounded = (operation, localDeadline = deadline, holdTarget = false) => new Promise(resolve => {
    const limit = boundary();
    if (limit) { resolve({ reason: limit }); return; }
    let settled = false, timer;
    const settle = value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); resolve(value); };
    const abort = () => settle({ reason: 'ABORTED' });
    const expires = Math.min(deadline, localDeadline);
    timer = setTimeout(() => settle({ reason: expires === deadline ? 'TIMEOUT' : 'VERIFICATION_TIMEOUT' }), Math.max(0, Math.ceil(expires - now())));
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!settled) {
      const pending = Promise.resolve().then(operation);
      if (holdTarget) pendingReads.add(pending);
      const accept = value => {
        pendingReads.delete(pending);
        const reason = boundary() ?? (now() >= expires ? 'VERIFICATION_TIMEOUT' : undefined);
        settle(reason ? { reason } : value);
      };
      pending.then(value => accept({ value }), error => accept({ reason: 'READ_FAILED', ...safeAdapterError(error) }));
    }
  });
  let allowedOrigins = plan.allowedOrigins;
  const observe = async (localDeadline = deadline) => {
    const readStarted = now(); metrics.observations++;
    const result = await bounded(async () => {
      let observation;
      if (typeof target.getObservation === 'function') observation = await target.getObservation();
      else {
        observation = parseAX(await target.getAXState({ emit: false, disableDiffing: true }));
        observation.url = typeof target.url === 'function' ? await target.url() : undefined;
      }
      if (!record(observation) || typeof observation.text !== 'string' || observation.text.length > 100000
        || !Array.isArray(observation.elements) || observation.elements.length > 199 || !originOf(observation.url)
        || (observation.title !== undefined && typeof observation.title !== 'string')) throw new Error();
      const refs = new Set();
      const elements = observation.elements.map(element => {
        if (!record(element) || !Number.isSafeInteger(element.ref) || element.ref < 0 || refs.has(element.ref)
          || !positive(element.role) || typeof element.name !== 'string') throw new Error();
        refs.add(element.ref);
        const copy = { ref: element.ref, role: element.role, name: element.name };
        for (const key of ['description', 'value', 'identity']) {
          if (element[key] !== undefined) { if (typeof element[key] !== 'string') throw new Error(); copy[key] = element[key]; }
        }
        if (element.editable !== undefined) { if (typeof element.editable !== 'boolean') throw new Error(); copy.editable = element.editable; }
        if (element.disabled !== undefined && typeof element.disabled !== 'boolean') throw new Error();
        if (element.protected !== undefined && typeof element.protected !== 'boolean') throw new Error();
        if (element.disabled || protectedRole(element)) copy.disabled = true;
        if (protectedRole(element)) copy.protected = true;
        return Object.freeze(copy);
      });
      return Object.freeze({ text: observation.text, url: observation.url,
        ...(observation.title !== undefined ? { title: observation.title } : {}), elements: Object.freeze(elements) });
    }, localDeadline, true);
    metrics.observationMs += Math.max(0, now() - readStarted);
    if (result.reason) return { reason: result.reason === 'READ_FAILED' ? 'OBSERVATION_FAILED' : result.reason, detail: result.detail };
    const observation = result.value;
    allowedOrigins ??= [originOf(observation.url)];
    if (!allowedOrigins.includes(originOf(observation.url))) return { reason: 'OUT_OF_SCOPE' };
    return { observation };
  };
  try {
    let read = await observe();
    if (read.reason) return finish(read.reason, read.detail);
    let observation = read.observation;
    for (;;) {
      if (boundary()) return finish(boundary());
      const decisionStarted = now(); metrics.decisions++;
      const answer = await bounded(() => decider.decide({ goal: plan.goal, completion: plan.completion,
        observation, actions: plan.actions, history: Object.freeze(history.slice(-10)) }));
      metrics.decisionMs += Math.max(0, now() - decisionStarted);
      if (answer.reason) return finish(answer.reason === 'READ_FAILED' ? 'DECISION_FAILED' : answer.reason);
      const decision = answer.value;
      if (decision?.status === 'needs_host') return finish(safeReason(decision.reason) ? decision.reason : 'DECISION_REQUIRED', decision.detail,
        safeDecisionDiagnostics(decision.diagnostics, plan.actions, observation.elements));
      if (!record(decision) || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) return finish('INVALID_DECISION');
      if (decision.status === 'done') {
        read = await observe();
        if (read.reason) return finish(read.reason, read.detail);
        return goalCompletionMatches(read.observation, plan.completion) ? finish() : finish('COMPLETION_NOT_VERIFIED');
      }
      if (completedSteps >= plan.maxSteps) return finish('MAX_STEPS');
      const action = plan.actions.find(a => a.id === decision.actionId);
      const element = observation.elements.find(e => e.ref === decision.ref);
      if (decision.status !== 'decided' || !action || !element || element.disabled || !matchesActionTarget(element, action)
        || (action.action === 'typeText' && element.editable === false)) return finish('INVALID_DECISION');
      read = await observe();
      if (read.reason) return finish(read.reason, read.detail);
      const current = resolveStableTarget(observation, read.observation, element.ref);
      if (!current || !matchesActionTarget(current, action)) {
        // Only a rejected pre-dispatch decision can be replaced. Never execute its
        // old ref or append a success to history; a new decision must pass this guard.
        const samePage = observation.url === read.observation.url
          && typeof observation.title === 'string' && observation.title === read.observation.title;
        if (!samePage || metrics.staleReplans >= plan.maxStaleReplans) return finish('STALE_OBSERVATION');
        metrics.staleReplans++;
        replans.push({ index: metrics.staleReplans, afterCompletedSteps: completedSteps,
          actionId: action.id, rejectedRef: element.ref, reason: 'STALE_OBSERVATION', actionDispatched: false });
        observation = read.observation;
        continue;
      }
      const before = progressFingerprint(read.observation);
      const completedBefore = goalCompletionMatches(read.observation, plan.completion);
      if (boundary()) return finish(boundary());
      const step = { index: steps.length, actionId: action.id, action: action.action, ref: current.ref, status: 'action_outcome_unknown' };
      steps.push(step);
      const actionStarted = now(); metrics.actions++;
      try {
        // Physical actions are awaited to settlement, never detached on timeout.
        if (action.action === 'click') await target.click(current.ref);
        else if (action.action === 'typeText') await target.typeText(current.ref, action.text);
        else if (action.action === 'pressKey') await target.pressKey(current.ref, action.key);
        else await target.scroll(current.ref, action.direction, 1);
      } catch (error) { Object.assign(step, safeAdapterError(error)); return finish('ACTION_FAILED', step.detail); }
      finally { step.actionMs = Math.max(0, now() - actionStarted); metrics.actionMs += step.actionMs; }
      step.status = 'action_performed_unverified';
      if (boundary(true)) return finish(boundary(true));
      const verificationDeadline = Math.min(deadline, now() + plan.verificationTimeoutMs);
      for (;;) {
        read = await observe(plan.verificationTimeoutMs > 0 ? verificationDeadline : deadline);
        if (read.reason) return finish(read.reason === 'VERIFICATION_TIMEOUT' ? 'NO_OBSERVABLE_PROGRESS' : read.reason, read.detail);
        if (progressFingerprint(read.observation) !== before
          || (!completedBefore && goalCompletionMatches(read.observation, plan.completion))) break;
        if (now() >= verificationDeadline) return finish('NO_OBSERVABLE_PROGRESS');
        const pause = await bounded(() => new Promise(resolve => setTimeout(resolve, 50)), verificationDeadline);
        if (pause.reason) return finish(pause.reason === 'VERIFICATION_TIMEOUT' ? 'NO_OBSERVABLE_PROGRESS' : pause.reason);
      }
      observation = read.observation;
      step.status = 'observed_after_action';
      completedSteps++;
      history.push(Object.freeze({ actionId: action.id, ref: current.ref }));
    }
  } finally {
    // A late browser read can replace a ref registry. Keep its lease until it
    // settles, even though this workflow already returned a bounded timeout.
    if (pendingReads.size) Promise.allSettled([...pendingReads]).then(() => activeTargets.delete(target));
    else activeTargets.delete(target);
  }
}
