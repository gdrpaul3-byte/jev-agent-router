import { createHash } from 'node:crypto';
import { prepareGoalPlan, goalCompletionMatches } from './goal.mjs';
import { matchesActionTarget } from './decider.mjs';
import { normalizeClaudeObservation, parseRefCheck, revealsPassword, sensitiveElement } from './claude-observation.mjs';

// This is a host-assisted bridge, not an implementation of Chrome's private transport.
const MAX_AGE_MS = 60000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stop = reason => ({ status: 'needs_host', reason });
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const reason = value => code(value) ? value : 'DECISION_FAILED';
// A value the host's input tool reported (valueSource "tool_report") is shown to JEV but is not page evidence,
// so it never takes part in identity or progress comparisons.
const identity = element => JSON.stringify(Object.fromEntries(['role', 'name', 'description', 'value', 'disabled', 'editable', 'protected']
  .filter(key => element[key] !== undefined && !(key === 'value' && element.valueSource === 'tool_report')).map(key => [key, element[key]])));
const digest = element => hash(identity(element)).slice(0, 16);
const bound = (element, check) => ['role', 'name', 'description'].every(key => element[key] === check[key]);
// Click progress ignores elements that already changed on their own between the decide and authorize reads
// (counters, carousels, rotating placeholders): by ref, and by identity so a re-mounted copy with a new ref is ignored too.
const candidateHash = (observation, volatile = [], volatileDigests = []) => hash(observation.elements
  .filter(element => !volatile.includes(element.ref) && !volatileDigests.includes(digest(element))).map(identity).sort());
const stableTitle = value => typeof value === 'string' ? value.replace(/^\(\d{1,6}\+?\)\s*/, '') : undefined;
const completionMatches = (observation, completion) => goalCompletionMatches({ text: observation.text, url: observation.tab.url }, completion);
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
// read_page names a field that has no label, aria-label or placeholder by its value: trimmed, whitespace collapsed, below 50 chars.
const valueName = value => value.length < 50 && value.trim() ? value.trim().replace(/\s+/g, ' ') : '';

// Mirrors the goal runner's sanitized diagnostics; target choices are mapped back to observed refs.
function decisionDiagnostics(value, plan, observation) {
  if (!record(value) || !['OPERATION', 'TARGET'].includes(value.head) || !probability(value.confidence) || !probability(value.margin)) return undefined;
  let choice;
  if (value.head === 'OPERATION') choice = ['DONE', 'BLOCKED'].includes(value.choice) || plan.actions.some(action => action.id === value.choice) ? value.choice : undefined;
  else if (value.choice === 'NONE') choice = 'NONE';
  else {
    const index = typeof value.choice === 'string' ? /^e_(0|[1-9]\d{0,2})$/.exec(value.choice)?.[1] : undefined;
    choice = index !== undefined ? observation.elements[Number(index)]?.ref : undefined;
  }
  return choice ? { head: value.head, choice, confidence: value.confidence, margin: value.margin } : undefined;
}

// Claude in Chrome 1.0.94 form_input reports the field value read back after its input/change events:
//   Set <kind> value to "<value>" (previous: "<old>")      text-like inputs and textarea (observed live)
//   Set <type> to "<value>" (previous: <old>)              date, time and similar inputs
//   Set number input to <value> (previous: <old>)          number inputs
// Its select report echoes the requested option rather than reading the selection back, so it is not evidence;
// a select is verified from its observed name. Protected fields are reported as [redacted].
// Returns the reported previous value, or undefined unless the report is exactly for the complete host text.
function reportedPrevious(toolResult, text) {
  if (typeof toolResult !== 'string' || toolResult.length > 200000 || text === '[redacted]') return undefined;
  const report = toolResult.replace(/^\[form_input\] ?/, '').replace(/\r?\n$/, '');
  const forms = [[/^Set [a-z][a-z-]{0,31} value to "/, `${text}" (previous: "`, '")'], [/^Set [a-z][a-z-]{0,31} to "/, `${text}" (previous: `, ')'],
    [/^Set number input to /, `${text} (previous: `, ')']];
  for (const [start, head, tail] of forms) {
    const match = start.exec(report);
    if (!match) continue;
    const rest = report.slice(match[0].length);
    return rest.startsWith(head) && rest.endsWith(tail) && rest.length >= head.length + tail.length ? rest.slice(head.length, rest.length - tail.length) : undefined;
  }
  return undefined;
}

// A host may supply the documented envelope or the verbatim tool text of one observation batch. An envelope
// that a caller built from raw text (the session ledger) passes `refCheck` to keep the binding check.
function observationInput(input, epoch) {
  if (input?.raw === undefined) return { observation: input?.observation, ...(input?.refCheck !== undefined ? { raw: true, refCheck: input.refCheck } : {}) };
  if (input.observation !== undefined) return stop('INVALID_OBSERVATION');
  const normalized = normalizeClaudeObservation(input.raw, { now: () => epoch });
  return normalized.status === 'observed' ? { observation: normalized.observation, raw: true, refCheck: input.raw.refCheck } : normalized;
}

// Raw listings can carry forged lines (raw attributes may contain newlines), so an action target must also
// match the first line of read_page ref_id for that ref. Host-built envelopes are trusted as before.
function checkBinding(prepared, target) {
  if (!prepared.raw) return undefined;
  const check = parseRefCheck(prepared.refCheck, target.ref);
  if (check.status !== 'parsed') return check;
  return bound(target, check.element) ? undefined : stop('TARGET_BINDING_MISMATCH');
}

function prepare(input, epoch) {
  const plan = prepareGoalPlan(input?.plan);
  if (!plan?.allowedOrigins || plan.actions.some(action => !['click', 'typeText'].includes(action.action))) return stop('INVALID_PLAN');
  const supplied = observationInput(input, epoch);
  if (supplied.status) return supplied;
  const source = supplied.observation;
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
        || ['disabled', 'editable', 'protected'].some(key => element[key] !== undefined && typeof element[key] !== 'boolean')
        || (element.valueSource !== undefined && (element.valueSource !== 'tool_report' || typeof element.value !== 'string'))) return stop('INVALID_OBSERVATION');
    if (sensitiveElement(element)) return stop('INVALID_OBSERVATION');
    refs.add(element.ref);
    const copied = { ref: element.ref, role: element.role, name: element.name };
    for (const key of ['description', 'value', 'valueSource', 'disabled', 'editable', 'protected']) if (element[key] !== undefined) copied[key] = element[key];
    elements.push(copied);
  }
  // Mirrors the parser: with a show/hide password control present, no editable field is sent.
  if (revealsPassword(elements, source.text) && elements.some(element => element.editable === true || /^(?:textbox|searchbox)$/.test(element.role))) return stop('INVALID_OBSERVATION');
  return { plan, raw: supplied.raw === true, refCheck: supplied.refCheck, observation: { source: source.source, observedAtEpochMs: source.observedAtEpochMs,
    tab: { id: source.tab.id, url: source.tab.url, ...(source.tab.title !== undefined ? { title: source.tab.title } : {}) }, text: source.text, elements } };
}

/** Observation is the documented local normalized envelope, or verbatim tool text under `raw`. */
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
  if (decision?.status === 'needs_host') {
    const diagnostics = decisionDiagnostics(decision.diagnostics, plan, observation);
    return { ...stop(reason(decision.reason)), ...(code(decision.detail) ? { detail: decision.detail } : {}), ...(diagnostics ? { diagnostics } : {}) };
  }
  if (!record(decision) || !['decided', 'done'].includes(decision.status)
      || !Number.isFinite(decision.confidence) || decision.confidence < 0.75 || decision.confidence > 1) return stop('INVALID_DECISION');
  const proposal = { version: 1, createdAtEpochMs: now(), planHash: hash(plan), source: { ...observation.tab, observedAtEpochMs: observation.observedAtEpochMs },
    decision: decision.status, confidence: decision.confidence,
    sourceElements: Object.fromEntries(observation.elements.map(element => [element.ref, digest(element)])) };
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

function checkProposal(proposal, plan, epoch, checkExpiry = true) {
  if (!record(proposal) || proposal.version !== 1 || !record(proposal.source)
      || !Number.isSafeInteger(proposal.createdAtEpochMs) || !['done', 'decided'].includes(proposal.decision)) return 'INVALID_PROPOSAL';
  const { digest: proposalDigest, ...body } = proposal;
  if (proposalDigest !== hash(body)) return 'INVALID_PROPOSAL';
  const elements = proposal.sourceElements;
  if (elements !== undefined && (!record(elements) || Object.keys(elements).length > 200
      || Object.values(elements).some(value => typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)))) return 'INVALID_PROPOSAL';
  if (proposal.planHash !== hash(plan)) return 'PLAN_CHANGED';
  if (checkExpiry && (epoch < proposal.createdAtEpochMs || epoch - proposal.createdAtEpochMs > MAX_AGE_MS)) return 'PROPOSAL_EXPIRED';
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
  const unbound = checkBinding(prepared, target);
  if (unbound) return unbound;
  const toolCall = action.action === 'click'
    ? { tool: 'computer', arguments: { action: 'left_click', tabId: observation.tab.id, ref: target.ref } }
    : { tool: 'form_input', arguments: { tabId: observation.tab.id, ref: target.ref, value: action.text } };
  // Elements that appeared, disappeared or changed between the decide and authorize reads change on their own.
  // The target itself cannot be among them: it was just checked to be unchanged.
  const earlier = proposal.sourceElements;
  const volatileRefs = !record(earlier) ? [] : [...new Set([...Object.keys(earlier), ...observation.elements.map(element => element.ref)])]
    .filter(ref => earlier[ref] !== digestOf(observation, ref)).sort();
  const volatileDigests = [...new Set(volatileRefs.flatMap(ref => [earlier[ref], digestOf(observation, ref)]).filter(value => typeof value === 'string'))].sort();
  return { status: 'authorized', authorizedAtEpochMs: epoch, proposal, toolCall,
    beforeProgress: { url: observation.tab.url, ...(observation.tab.title !== undefined ? { title: observation.tab.title } : {}),
      candidatesHash: candidateHash(observation, volatileRefs, volatileDigests), volatileRefs, volatileDigests,
      completionMatches: completionMatches(observation, plan.completion) } };
}

function digestOf(observation, ref) {
  const element = observation.elements.find(item => item.ref === ref);
  return element ? digest(element) : undefined;
}

/** A settled tool call is not proof. Observe afterward; never retry an unknown outcome blindly. */
export function verifyClaudeChromeAction(input, { now = Date.now } = {}) {
  const epoch = now(), prepared = prepare(input, epoch);
  if (prepared.status) return prepared;
  const { plan, observation } = prepared, authorization = input.authorization;
  if (!record(authorization) || authorization.status !== 'authorized' || !Number.isSafeInteger(authorization.authorizedAtEpochMs)) return stop('INVALID_AUTHORIZATION');
  // The proposal only had to be fresh when it was authorized; verification is bounded from that authorization.
  const invalid = checkProposal(authorization.proposal, plan, epoch, false);
  if (invalid) return stop(invalid);
  if (authorization.authorizedAtEpochMs < authorization.proposal.createdAtEpochMs) return stop('INVALID_AUTHORIZATION');
  if (epoch < authorization.authorizedAtEpochMs || epoch - authorization.authorizedAtEpochMs > MAX_AGE_MS) return stop('AUTHORIZATION_EXPIRED');
  if (observation.observedAtEpochMs <= authorization.authorizedAtEpochMs) return stop('FRESH_OBSERVATION_REQUIRED');
  if (observation.tab.id !== authorization.proposal.source.id) return stop('TAB_CHANGED');
  const action = plan.actions.find(item => item.id === authorization.proposal.actionId);
  if (!action) return stop('INVALID_AUTHORIZATION');
  let inputEvidence;
  if (action.action === 'typeText') {
    const before = authorization.proposal.target;
    const target = observation.elements.find(element => element.ref === before?.ref);
    if (observation.tab.url !== authorization.proposal.source.url || !target || !record(before)) return stop('INPUT_NOT_VERIFIED');
    const unbound = checkBinding(prepared, target);
    if (unbound) return unbound;
    const unchanged = identity({ ...target, value: undefined }) === identity({ ...before, value: undefined });
    const sameField = identity({ ...target, name: '', value: undefined }) === identity({ ...before, name: '', value: undefined });
    // A value remembered from an earlier tool report does not mean the page showed a value before this action.
    const shownBefore = before.value !== undefined && before.valueSource !== 'tool_report';
    const renamedToText = target.name === action.text && before.name !== action.text && !shownBefore && sameField;
    // A report written before this authorization cannot describe this action.
    const reportTime = input.toolResultAtEpochMs;
    const previous = reportTime === undefined || (Number.isSafeInteger(reportTime) && reportTime > authorization.authorizedAtEpochMs)
      ? reportedPrevious(input.toolResult, action.text) : undefined;
    // A value-named field is renamed from its old value to the new one; accept only the names the report implies.
    const renamedByReport = previous !== undefined && sameField && !shownBefore
      && before.name === valueName(previous) && target.name === valueName(action.text);
    // An observed value always wins. read_page omits values, but a nameless field is named by its value.
    if (target.value !== undefined && target.valueSource !== 'tool_report') inputEvidence = unchanged && matchesActionTarget(target, action) && target.value === action.text ? 'observed_value' : undefined;
    else if (renamedToText) inputEvidence = 'observed_name';
    else if (previous !== undefined && ((unchanged && matchesActionTarget(target, action)) || renamedByReport)) inputEvidence = 'tool_report';
    if (!inputEvidence) return stop('INPUT_NOT_VERIFIED');
  } else {
    const before = authorization.beforeProgress;
    const volatile = before?.volatileRefs ?? [], volatileDigests = before?.volatileDigests ?? [];
    if (!record(before) || before.url !== authorization.proposal.source.url || !/^[a-f0-9]{64}$/.test(before.candidatesHash ?? '')
        || typeof before.completionMatches !== 'boolean' || (before.title !== undefined && typeof before.title !== 'string')
        || ![volatile, volatileDigests].every(list => Array.isArray(list) && list.length <= 800 && list.every(item => typeof item === 'string'))) return stop('INVALID_AUTHORIZATION');
    const titleBefore = stableTitle(before.title), titleAfter = stableTitle(observation.tab.title);
    // A title that already changed between the decide and authorize reads is live churn, not progress.
    const titleSettled = authorization.proposal.source.title === undefined || stableTitle(authorization.proposal.source.title) === titleBefore;
    const changed = observation.tab.url !== before.url
      || (titleBefore !== undefined && titleAfter !== undefined && titleAfter !== titleBefore && titleSettled)
      || candidateHash(observation, volatile, volatileDigests) !== before.candidatesHash
      || (!before.completionMatches && completionMatches(observation, plan.completion));
    if (!changed) return stop('NO_OBSERVABLE_PROGRESS');
  }
  return { status: 'observed_after_action', historyEntry: { actionId: action.id }, ...(inputEvidence ? { inputEvidence } : {}),
    completionMatches: goalCompletionMatches({ text: observation.text, url: observation.tab.url }, plan.completion),
    tabId: observation.tab.id, url: observation.tab.url };
}
