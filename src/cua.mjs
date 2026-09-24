// This module intentionally uses only standard JavaScript globals so it can run
// inside the persistent CUA host as well as Node.
import { resolveStableTarget } from './observation.mjs';
import { prepareGoalActions, matchesActionTarget } from './decider.mjs';
const roles = [
  'secure text field', 'search text field', 'text entry area', 'disclosure triangle',
  'segmented control', 'pop up button', 'radio button', 'toggle button', 'menu button',
  'search field', 'text field', 'text area', 'check box', 'combo box', 'menu item',
  'scroll area', 'scroll bar', 'incrementor', 'list box', 'tree item', 'button',
  'link', 'slider', 'switch', 'stepper', 'tab',
].sort((a, b) => b.length - a.length);
const axRoles = new Map([
  ['AXButton', 'button'], ['AXLink', 'link'], ['AXTextField', 'text field'],
  ['AXSearchField', 'search field'], ['AXTextArea', 'text area'],
  ['AXCheckBox', 'check box'], ['AXRadioButton', 'radio button'],
  ['AXComboBox', 'combo box'], ['AXPopUpButton', 'pop up button'],
  ['AXSlider', 'slider'], ['AXMenuItem', 'menu item'], ['AXTab', 'tab'],
  ['AXScrollArea', 'scroll area'], ['AXScrollBar', 'scroll bar'],
]);
const rolePattern = new RegExp(`^(${roles.join('|')})(?=$|\\s|\\()`, 'i');
const malformedRolePattern = new RegExp(`^[^\\s]+\\s+(?:${roles.join('|')}|${[...axRoles.keys()].join('|')})(?=$|\\s|\\()`, 'i');
const editableRoles = new Set(['text field', 'search field', 'search text field', 'text area', 'text entry area', 'combo box']);
const protectedElements = new WeakSet();
export const activeTargets = new WeakSet();
export const isProtectedElement = element => protectedElements.has(element);
const now = () => globalThis.performance?.now() ?? Date.now();
const adapterErrorCodes = new Set([
  'STALE_OBSERVATION', 'INVALID_TARGET', 'OBSERVATION_FAILED', 'INVALID_OBSERVATION',
  'OBSERVATION_TOO_LARGE', 'IFRAMES_UNSUPPORTED', 'LOCATOR_ENGINE_FAILED',
  'CDP_CONNECTION_FAILED', 'ACTION_TIMEOUT', 'INPUT_VALUE_MISMATCH', 'ACTION_FAILED',
]);

// Adapter diagnostics are fixed classifications; raw exception text can contain
// page content or typed input and must never enter workflow logs.
export function safeAdapterError(error) {
  const code = adapterErrorCodes.has(error?.code) ? error.code : undefined;
  const detail = adapterErrorCodes.has(error?.detail) ? error.detail : code;
  return { ...(code ? { errorCode: code } : {}), ...(detail ? { detail } : {}),
    ...(code && error.actionDispatched === false ? { status: 'action_not_dispatched' } : {}) };
}

function roleAtStart(body) {
  const readable = rolePattern.exec(body);
  if (readable) return { role: readable[1].toLowerCase(), length: readable[0].length };
  const firstWord = /^\S+/.exec(body)?.[0];
  const role = axRoles.get(firstWord);
  return role ? { role, length: firstWord.length } : undefined;
}

function readLabel(rest) {
  const fields = {};
  const markers = [...rest.matchAll(/(?:^|,\s*)(Description|Value|Title|Label|Help|ID|URL|Secondary Actions|Enabled|Disabled|Role|Placeholder):\s*/g)];
  const name = (markers.length ? rest.slice(0, markers[0].index) : rest).replace(/,\s*$/, '').trim();
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    fields[marker[1]] = rest.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? rest.length).trim();
  }
  return { name: name || fields.Description || fields.Title || fields.Label || fields.Placeholder || '', fields };
}

/** Parse a complete getAXState string; wrapper and noninteractive text stay intact. */
export function parseAX(text) {
  if (typeof text !== 'string') throw new TypeError('AX observation must be a string');
  if (!text.trim()) throw new TypeError('AX observation is empty');
  const elements = [];
  const refs = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\S.*)$/.exec(trimmed);
    if (!match) {
      if (/^[+\-]?\d/.test(trimmed) || malformedRolePattern.test(trimmed) || roleAtStart(trimmed)) {
        throw new TypeError('Malformed AX reference');
      }
      continue; // CUA may prefix the tree with tab metadata.
    }
    const ref = Number(match[1]);
    if (!Number.isSafeInteger(ref) || String(ref) !== match[1]) throw new TypeError('Invalid AX reference');
    if (refs.has(ref)) throw new TypeError('Duplicate AX reference');
    refs.add(ref);
    const found = roleAtStart(match[2]);
    if (!found) continue;
    let rest = match[2].slice(found.length).trim();
    let qualifiers = '';
    while (rest.startsWith('(')) {
      const end = rest.indexOf(')');
      if (end < 0) throw new TypeError('Malformed AX role');
      qualifiers += ` ${rest.slice(1, end)}`;
      rest = rest.slice(end + 1).trim();
    }
    const { name, fields } = readLabel(rest);
    const element = { ref, role: found.role, name };
    if ('Description' in fields) element.description = fields.Description;
    if ('Value' in fields) element.value = fields.Value;
    if (/\bdisabled\b/i.test(qualifiers) || /^false$/i.test(fields.Enabled ?? '') || /^true$/i.test(fields.Disabled ?? '')) element.disabled = true;
    if (/\b(?:protected|secure|password)\b/i.test(`${found.role} ${qualifiers}`)
      || (editableRoles.has(found.role) && /\b(?:password|passcode)\b/i.test(`${name} ${fields.Description ?? ''} ${fields.ID ?? ''}`))) {
      protectedElements.add(element);
    }
    elements.push(element);
  }
  if (!refs.size) throw new TypeError('Invalid AX observation: no references');
  return { text, elements };
}

function copyPlan(steps) {
  if (!Array.isArray(steps) || !steps.length) return undefined;
  const copy = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof step.instruction !== 'string' || !step.instruction.trim()) return undefined;
    if (!['click', 'typeText', 'pressKey', 'scroll'].includes(step.action)) return undefined;
    if (step.requiresHost !== undefined && typeof step.requiresHost !== 'boolean') return undefined;
    if (!step.expect || typeof step.expect !== 'object' || Array.isArray(step.expect)) return undefined;
    const keys = Object.keys(step.expect);
    if (keys.length !== 1 || !['textIncludes', 'textExcludes'].includes(keys[0])) return undefined;
    const key = keys[0];
    if (typeof step.expect[key] !== 'string' || !step.expect[key].trim()) return undefined;
    if (step.action === 'typeText' && typeof step.text !== 'string') return undefined;
    if (step.action === 'pressKey' && (typeof step.key !== 'string' || !step.key.trim())) return undefined;
    if (step.action === 'scroll' && !['up', 'down', 'left', 'right'].includes(step.direction)) return undefined;
    let target;
    if (step.target !== undefined) {
      const prepared = prepareGoalActions([{ id: 'fixed', action: step.action, description: step.instruction,
        text: step.text, key: step.key, direction: step.direction, target: step.target }]);
      if (!prepared) return undefined;
      target = prepared[0].target;
    }
    copy.push({
      instruction: step.instruction,
      action: step.action,
      ...(step.action === 'typeText' ? { text: step.text } : {}),
      ...(step.action === 'pressKey' ? { key: step.key } : {}),
      ...(step.action === 'scroll' ? { direction: step.direction } : {}),
      expect: { [key]: step.expect[key] },
      requiresHost: step.requiresHost === true,
      ...(target ? { target } : {}),
    });
  }
  return copy;
}

/** Pure validation and copying, safe to call before browser or provider startup. */
export function prepareWorkflowPlan(options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
    const { goal, steps, maxSteps = 12, maxDurationMs = 45000, verificationTimeoutMs = 0, reuseVerifiedObservation } = options;
    const plan = copyPlan(steps);
    if (!plan || typeof goal !== 'string' || !goal.trim()
      || !Number.isSafeInteger(maxSteps) || maxSteps < 1
      || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0
      || !Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs < 0
      || (reuseVerifiedObservation !== undefined && typeof reuseVerifiedObservation !== 'boolean')) return null;
    return { goal, steps: plan, maxSteps, maxDurationMs, verificationTimeoutMs,
      ...(reuseVerifiedObservation !== undefined ? { reuseVerifiedObservation } : {}) };
  } catch { return null; }
}

const meets = (text, expect) => 'textIncludes' in expect
  ? text.includes(expect.textIncludes)
  : !text.includes(expect.textExcludes);

function freezeObservation(observation) {
  for (const element of observation.elements) Object.freeze(element);
  Object.freeze(observation.elements);
  return Object.freeze(observation);
}

function copyStructuredObservation(source) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(source) || typeof source.text !== 'string' || source.text.length > 100000
    || !Array.isArray(source.elements) || source.elements.length > 199
    || (source.axText !== undefined && (typeof source.axText !== 'string' || source.axText.length > 100000))) throw new TypeError();
  const observation = { text: source.axText ?? source.text, elements: [] };
  for (const key of ['url', 'title']) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string') throw new TypeError();
      observation[key] = source[key];
    }
  }
  const refs = new Set();
  for (const original of source.elements) {
    if (!record(original) || !Number.isSafeInteger(original.ref) || original.ref < 0 || refs.has(original.ref)
      || typeof original.role !== 'string' || !original.role.trim() || typeof original.name !== 'string') throw new TypeError();
    refs.add(original.ref);
    const element = { ref: original.ref, role: original.role, name: original.name };
    for (const key of ['description', 'value', 'identity']) {
      if (original[key] !== undefined) {
        if (typeof original[key] !== 'string') throw new TypeError();
        element[key] = original[key];
      }
    }
    for (const key of ['disabled', 'editable', 'protected']) {
      if (original[key] !== undefined) {
        if (typeof original[key] !== 'boolean') throw new TypeError();
        element[key] = original[key];
      }
    }
    if (original.protected || protectedElements.has(original)
      || /\b(?:secure|protected|password)\b/i.test(original.role)
      || (editableRoles.has(original.role) && /\b(?:password|passcode)\b/i.test(`${original.name} ${original.description ?? ''}`))) protectedElements.add(element);
    observation.elements.push(element);
  }
  return freezeObservation(observation);
}

/** Execute only host-authored operations. The selector can choose a ref, never an action. */
export async function runCuaWorkflow({ target, selector, goal, steps, maxSteps = 12, maxDurationMs = 45000, verificationTimeoutMs = 0, reuseVerifiedObservation = false, signal } = {}) {
  const started = now();
  const records = [];
  let completedSteps = 0;
  const finish = (reason, detail) => ({
    status: reason ? 'needs_host' : 'completed',
    ...(reason ? { reason } : {}),
    ...(adapterErrorCodes.has(detail) ? { detail } : {}),
    completedSteps,
    steps: records,
    durationMs: Math.max(0, now() - started),
  });
  const prepared = prepareWorkflowPlan({ goal, steps, maxSteps, maxDurationMs, verificationTimeoutMs, reuseVerifiedObservation });
  const plan = prepared?.steps;
  if (!plan
    || !target || (typeof target.getObservation !== 'function' && typeof target.getAXState !== 'function')
    || !selector || typeof selector.select !== 'function'
    || plan.some(step => typeof target[step.action] !== 'function')) return finish('INVALID_PLAN');
  if (activeTargets.has(target)) return finish('TARGET_BUSY');
  activeTargets.add(target);
  const boundary = (afterAction = false) => {
    if (signal?.aborted) return afterAction ? 'ABORTED_AFTER_ACTION' : 'ABORTED';
    if (now() - started >= maxDurationMs) return afterAction ? 'TIMEOUT_AFTER_ACTION' : 'TIMEOUT';
    return undefined;
  };
  // Reads and selection may time out without dispatching an action. Their late
  // results remain consumed, but can never resume the finished workflow.
  const pendingReads = new Set();
  const boundedRead = (operation, localDeadline = Infinity, localReason = 'TIMEOUT', holdTarget = false) => {
    const limit = boundary();
    if (limit) return Promise.resolve({ reason: limit });
    if (now() >= localDeadline) return Promise.resolve({ reason: localReason });
    const globalDeadline = started + maxDurationMs;
    const deadline = Math.min(globalDeadline, localDeadline);
    const timeoutReason = globalDeadline <= localDeadline ? 'TIMEOUT' : localReason;
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const onAbort = () => settle({ reason: 'ABORTED' });
      const settle = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(result);
      };
      timer = setTimeout(() => settle({ reason: timeoutReason }), Math.min(2147483647, Math.ceil(deadline - now())));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (!settled) {
        const pending = Promise.resolve().then(operation);
        if (holdTarget) pendingReads.add(pending);
        const accept = result => {
          pendingReads.delete(pending);
          const reason = boundary() ?? (now() >= localDeadline ? localReason : undefined);
          settle(reason ? { reason } : result);
        };
        pending.then(value => accept({ value }), error => accept({ failed: true, ...safeAdapterError(error) }));
      }
    });
  };
  const observe = async (localDeadline = Infinity) => {
    const structured = typeof target.getObservation === 'function';
    const response = await boundedRead(() => structured ? target.getObservation()
      : target.getAXState({ emit: false, disableDiffing: true }), localDeadline, 'VERIFICATION_FAILED', true);
    if (response.reason) return response;
    if (response.failed) return { reason: 'OBSERVATION_FAILED', detail: response.detail };
    try { return { observation: structured ? copyStructuredObservation(response.value) : freezeObservation(parseAX(response.value)) }; }
    catch { return { reason: 'INVALID_OBSERVATION' }; }
  };
  try {
    let verifiedObservation;
    for (let index = 0; index < plan.length; index++) {
      const limit = boundary();
      if (limit) return finish(limit);
      if (index >= maxSteps) return finish('MAX_STEPS');
      const step = plan[index];
      const record = { index, status: 'needs_host' };
      records.push(record);
      if (step.requiresHost) return finish('HOST_REQUIRED');

      const initial = reuseVerifiedObservation && verifiedObservation ? { observation: verifiedObservation } : await observe();
      if (boundary()) return finish(boundary());
      if (initial.reason) return finish(initial.reason, initial.detail);
      const observation = initial.observation;
      if (meets(observation.text, step.expect)) return finish('POSTCONDITION_ALREADY_MET');

      const candidates = step.target ? observation.elements.filter(element => matchesActionTarget(element, step)) : observation.elements;
      if (step.target && !candidates.length) return finish('NO_SAFE_TARGET');
      // Keep the complete observation for freshness and verification; expose only
      // host-approved candidates to the selector for a scoped fixed step.
      const selectionObservation = step.target
        ? Object.freeze({ ...observation, elements: Object.freeze(candidates) }) : observation;

      const selectionStarted = now();
      const selectionResponse = await boundedRead(() => selector.select({ goal, instruction: step.instruction, observation: selectionObservation }));
      record.selectionMs = Math.max(0, now() - selectionStarted);
      if (boundary()) return finish(boundary());
      if (selectionResponse.reason) return finish(selectionResponse.reason);
      if (selectionResponse.failed) return finish('SELECTION_FAILED');
      const selection = selectionResponse.value;
      if (selection?.status === 'needs_host') {
        const reason = typeof selection.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(selection.reason) ? selection.reason : 'SELECTION_REQUIRED';
        return finish(reason);
      }
      if (selection?.status !== 'selected' || !Number.isSafeInteger(selection.ref)
        || typeof selection.confidence !== 'number' || !Number.isFinite(selection.confidence)
        || selection.confidence < 0 || selection.confidence > 1) return finish('INVALID_SELECTION');
      record.selectedRef = selection.ref;
      const selected = observation.elements.find(element => element.ref === selection.ref);
      if (!selected || selected.disabled || protectedElements.has(selected)
        || (step.target && !matchesActionTarget(selected, step))
        || (step.action === 'typeText' && (selected.editable === false || !editableRoles.has(selected.role)))) return finish('INVALID_TARGET');

      const refreshed = await observe();
      if (boundary()) return finish(boundary());
      if (refreshed.reason) return finish(refreshed.reason, refreshed.detail);
      const current = resolveStableTarget(observation, refreshed.observation, selected.ref);
      if (!current || current.disabled || protectedElements.has(current)
        || (step.target && !matchesActionTarget(current, step))) return finish('STALE_OBSERVATION');
      if (boundary()) return finish(boundary());

      // Never race or detach a physical action. If it crosses a deadline, wait for
      // settlement and return explicit performed/unknown metadata without retrying.
      const actionStarted = now();
      record.status = 'action_outcome_unknown';
      record.executedRef = current.ref;
      try {
        if (step.action === 'click') await target.click(current.ref);
        else if (step.action === 'typeText') await target.typeText(current.ref, step.text);
        else if (step.action === 'pressKey') await target.pressKey(current.ref, step.key);
        else await target.scroll(current.ref, step.direction, 1);
      } catch (error) {
        Object.assign(record, safeAdapterError(error));
        record.actionMs = Math.max(0, now() - actionStarted);
        return finish('ACTION_FAILED', record.detail);
      }
      record.actionMs = Math.max(0, now() - actionStarted);
      record.status = 'action_performed_unverified';
      if (boundary(true)) return finish(boundary(true));

      const verificationStarted = now();
      const verificationDeadline = verificationTimeoutMs > 0 ? verificationStarted + verificationTimeoutMs : Infinity;
      for (;;) {
        const verified = await observe(verificationDeadline);
        record.verificationMs = Math.max(0, now() - verificationStarted);
        if (boundary(true)) return finish(boundary(true));
        if (verified.reason) return finish(verified.reason, verified.detail);
        if (meets(verified.observation.text, step.expect)) { verifiedObservation = verified.observation; break; }
        if (verificationTimeoutMs === 0 || now() >= verificationDeadline) return finish('VERIFICATION_FAILED');
        // Poll only the independent condition. Never select again or repeat an input.
        const pause = await boundedRead(
          () => new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, verificationDeadline - now())))),
          verificationDeadline,
          'VERIFICATION_FAILED',
        );
        record.verificationMs = Math.max(0, now() - verificationStarted);
        if (boundary(true)) return finish(boundary(true));
        if (pause.reason) return finish(pause.reason);
      }
      record.status = 'completed';
      completedSteps++;
    }
    return finish();
  } finally {
    // A late physical read may replace the provider's ref registry.
    if (pendingReads.size) Promise.allSettled([...pendingReads]).then(() => activeTargets.delete(target));
    else activeTargets.delete(target);
  }
}
