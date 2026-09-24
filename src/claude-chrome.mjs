import { createHash } from 'node:crypto';
import { prepareGoalPlan, goalCompletionMatches } from './goal.mjs';
import { matchesActionTarget } from './decider.mjs';

// This is a host-assisted bridge, not an implementation of Chrome's private transport.
const MAX_AGE_MS = 60000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stop = reason => ({ status: 'needs_host', reason });
const reason = value => /^[A-Z][A-Z0-9_]{0,63}$/.test(value ?? '') ? value : 'DECISION_FAILED';
const sensitive = element => element.protected === true || /secure|password|protected/i.test(element.role)
  || (/text|search|combo/.test(element.role) && /\b(?:password|passcode|one[- ]time[- ]code|security[- ]code|card[- ]number|cvv|cvc)\b/i.test(`${element.name} ${element.description ?? ''}`));
const identity = element => JSON.stringify(Object.fromEntries(['role', 'name', 'description', 'value', 'disabled', 'editable', 'protected'].filter(key => element[key] !== undefined).map(key => [key, element[key]])));
const candidateHash = observation => hash(observation.elements.map(identity).sort());
const completionMatches = (observation, completion) => goalCompletionMatches({ text: observation.text, url: observation.tab.url }, completion);

function prepare(input, epoch) {
  const plan = prepareGoalPlan(input?.plan);
  if (!plan?.allowedOrigins || plan.actions.some(action => !['click', 'typeText'].includes(action.action))) return stop('INVALID_PLAN');
  const source = input?.observation;
  if (!record(source) || source.source !== 'claude-in-chrome' || !record(source.tab)
      || !Number.isSafeInteger(source.tab.id) || source.tab.id < 0
      || typeof source.tab.url !== 'string' || (source.tab.title !== undefined && typeof source.tab.title !== 'string') || typeof source.text !== 'string'
      || !Number.isSafeInteger(source.observedAtEpochMs) || source.observedAtEpochMs < 0
      || source.observedAtEpochMs > epoch || epoch - source.observedAtEpochMs > MAX_AGE_MS
      || !Array.isArray(source.elements) || source.elements.length > 200) return stop('INVALID_OBSERVATION');
  let url;
  try { url = new URL(source.tab.url); } catch { return stop('INVALID_OBSERVATION'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return stop('INVALID_OBSERVATION');
  if (!plan.allowedOrigins.includes(url.origin)) return stop('ORIGIN_NOT_ALLOWED');
  const refs = new Set(), elements = [];
  for (const element of source.elements) {
    if (!record(element) || element.visible !== true || !/^ref_[A-Za-z0-9_-]{1,80}$/.test(element.ref ?? '') || refs.has(element.ref)
        || typeof element.role !== 'string' || !element.role.trim() || typeof element.name !== 'string'
        || ['description', 'value'].some(key => element[key] !== undefined && typeof element[key] !== 'string')
      || ['disabled', 'editable', 'protected'].some(key => element[key] !== undefined && typeof element[key] !== 'boolean')) return stop('INVALID_OBSERVATION');
    if (sensitive(element)) return stop('INVALID_OBSERVATION');
    refs.add(element.ref);
    const copied = { ref: element.ref, role: element.role, name: element.name };
    for (const key of ['description', 'value', 'disabled', 'editable', 'protected']) if (element[key] !== undefined) copied[key] = element[key];
    elements.push(copied);
  }
  return { plan, observation: { source: source.source, observedAtEpochMs: source.observedAtEpochMs,
    tab: { id: source.tab.id, url: source.tab.url, ...(source.tab.title !== undefined ? { title: source.tab.title } : {}) }, text: source.text, elements } };
}

/** Observation is the documented local normalized envelope; it is not raw read_page syntax. */
export async function proposeClaudeChrome(input, { decider, now = Date.now } = {}) {
  const prepared = prepare(input, now());
  if (prepared.status) return prepared;
  if (typeof decider?.decide !== 'function') return stop('INVALID_DECIDER');
  const { plan, observation } = prepared;
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > plan.maxSteps || history.some(item => !record(item)
      || !plan.actions.some(action => action.id === item.actionId))) return stop('INVALID_HISTORY');
  const numeric = { text: observation.text, url: observation.tab.url,
    elements: observation.elements.map((element, ref) => ({ ...element, ref })) };
  let decision;
  try { decision = await decider.decide({ goal: plan.goal, actions: plan.actions, completion: plan.completion, observation: numeric, history: history.map(({ actionId }) => ({ actionId })) }); }
  catch { return stop('DECISION_FAILED'); }
  if (decision?.status === 'needs_host') return stop(reason(decision.reason));
  if (!record(decision) || !['decided', 'done'].includes(decision.status)
      || !Number.isFinite(decision.confidence) || decision.confidence < 0.75 || decision.confidence > 1) return stop('INVALID_DECISION');
  const proposal = { version: 1, createdAtEpochMs: now(), planHash: hash(plan), source: { ...observation.tab, observedAtEpochMs: observation.observedAtEpochMs },
    decision: decision.status, confidence: decision.confidence };
  if (decision.status === 'decided') {
    if (history.length >= plan.maxSteps) return stop('MAX_STEPS');
    const action = plan.actions.find(item => item.id === decision.actionId);
    const target = Number.isSafeInteger(decision.ref) ? observation.elements[decision.ref] : undefined;
    if (!action || !target || !matchesActionTarget(target, action)) return stop('INVALID_DECISION');
    if (observation.elements.filter(element => identity(element) === identity(target)).length !== 1) return stop('AMBIGUOUS_TARGET');
    proposal.actionId = action.id; proposal.target = target;
  }
  proposal.digest = hash(proposal);
  return { status: 'proposed', proposal };
}

function checkProposal(proposal, plan, epoch) {
  if (!record(proposal) || proposal.version !== 1 || !record(proposal.source)
      || !Number.isSafeInteger(proposal.createdAtEpochMs) || !['done', 'decided'].includes(proposal.decision)) return 'INVALID_PROPOSAL';
  const { digest, ...body } = proposal;
  if (digest !== hash(body)) return 'INVALID_PROPOSAL';
  if (proposal.planHash !== hash(plan)) return 'PLAN_CHANGED';
  if (epoch < proposal.createdAtEpochMs || epoch - proposal.createdAtEpochMs > MAX_AGE_MS) return 'PROPOSAL_EXPIRED';
}

/** Call immediately before the host invokes its official Claude in Chrome tool, once. */
export function authorizeClaudeChrome(input, { now = Date.now } = {}) {
  const epoch = now();
  const prepared = prepare(input, epoch);
  if (prepared.status) return prepared;
  const { plan, observation } = prepared, { proposal } = input;
  const invalid = checkProposal(proposal, plan, epoch);
  if (invalid) return stop(invalid);
  if (observation.observedAtEpochMs <= proposal.createdAtEpochMs) return stop('FRESH_OBSERVATION_REQUIRED');
  if (observation.tab.id !== proposal.source.id) return stop('TAB_CHANGED');
  if (proposal.decision === 'done') {
    return goalCompletionMatches({ text: observation.text, url: observation.tab.url }, plan.completion)
      ? { status: 'completed', verifiedAtEpochMs: epoch, tabId: observation.tab.id, url: observation.tab.url }
      : stop('COMPLETION_NOT_VERIFIED');
  }
  if (observation.tab.url !== proposal.source.url) return stop('URL_CHANGED');
  const action = plan.actions.find(item => item.id === proposal.actionId);
  const target = observation.elements.find(element => element.ref === proposal.target?.ref);
  if (!action || !target || identity(target) !== identity(proposal.target) || !matchesActionTarget(target, action)) return stop('STALE_TARGET');
  if (observation.elements.filter(element => identity(element) === identity(target)).length !== 1) return stop('AMBIGUOUS_TARGET');
  const toolCall = action.action === 'click'
    ? { tool: 'computer', arguments: { action: 'left_click', tabId: observation.tab.id, ref: target.ref } }
    : { tool: 'form_input', arguments: { tabId: observation.tab.id, ref: target.ref, value: action.text } };
  return { status: 'authorized', authorizedAtEpochMs: epoch, proposal, toolCall,
    beforeProgress: { url: observation.tab.url, ...(observation.tab.title !== undefined ? { title: observation.tab.title } : {}),
      candidatesHash: candidateHash(observation), completionMatches: completionMatches(observation, plan.completion) } };
}

/** A settled tool call is not proof. Observe afterward; never retry an unknown outcome blindly. */
export function verifyClaudeChromeAction(input, { now = Date.now } = {}) {
  const epoch = now(), prepared = prepare(input, epoch);
  if (prepared.status) return prepared;
  const { plan, observation } = prepared, authorization = input.authorization;
  if (!record(authorization) || authorization.status !== 'authorized' || !Number.isSafeInteger(authorization.authorizedAtEpochMs)) return stop('INVALID_AUTHORIZATION');
  const invalid = checkProposal(authorization.proposal, plan, epoch);
  if (invalid) return stop(invalid);
  if (observation.observedAtEpochMs <= authorization.authorizedAtEpochMs) return stop('FRESH_OBSERVATION_REQUIRED');
  if (observation.tab.id !== authorization.proposal.source.id) return stop('TAB_CHANGED');
  const action = plan.actions.find(item => item.id === authorization.proposal.actionId);
  if (!action) return stop('INVALID_AUTHORIZATION');
  if (action.action === 'typeText') {
    const target = observation.elements.find(element => element.ref === authorization.proposal.target.ref);
    if (observation.tab.url !== authorization.proposal.source.url || !target || !matchesActionTarget(target, action)
        || identity({ ...target, value: undefined }) !== identity({ ...authorization.proposal.target, value: undefined })
        || target.value !== action.text) return stop('INPUT_NOT_VERIFIED');
  } else {
    const before = authorization.beforeProgress;
    if (!record(before) || before.url !== authorization.proposal.source.url || !/^[a-f0-9]{64}$/.test(before.candidatesHash ?? '')
        || typeof before.completionMatches !== 'boolean' || (before.title !== undefined && typeof before.title !== 'string')) return stop('INVALID_AUTHORIZATION');
    const changed = observation.tab.url !== before.url
      || (typeof before.title === 'string' && typeof observation.tab.title === 'string' && observation.tab.title !== before.title)
      || candidateHash(observation) !== before.candidatesHash
      || (!before.completionMatches && completionMatches(observation, plan.completion));
    if (!changed) return stop('NO_OBSERVABLE_PROGRESS');
  }
  return { status: 'observed_after_action', historyEntry: { actionId: action.id },
    completionMatches: goalCompletionMatches({ text: observation.text, url: observation.tab.url }, plan.completion),
    tabId: observation.tab.id, url: observation.tab.url };
}
