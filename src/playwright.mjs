import { resolveStableTarget } from './observation.mjs';

const INTERACTIVE = 'a[href],button,input,textarea,select,[role],summary';
const MAX_TEXT_LENGTH = 20000;
const MAX_SNAPSHOT_LENGTH = 100000;
const AX_ROLES = new Set([
  'button', 'link', 'text field', 'search field', 'text area', 'check box', 'radio button',
  'pop up button', 'combo box', 'slider', 'switch', 'incrementor', 'menu item', 'tab', 'list box', 'tree item',
]);

// This function is serialized by Playwright. Keep it self-contained and strictly read-only.
function captureDOM() {
  const selector = 'a[href],button,input,textarea,select,[role],summary';
  const roleMap = {
    button: 'button', link: 'link', textbox: 'text field', searchbox: 'search field',
    checkbox: 'check box', radio: 'radio button', combobox: 'combo box', slider: 'slider',
    switch: 'switch', spinbutton: 'incrementor', menuitem: 'menu item', tab: 'tab',
    listbox: 'list box', treeitem: 'tree item',
  };
  const attr = (element, name) => element.getAttribute(name) ?? '';
  const tag = element => element.tagName.toLowerCase();
  const ancestors = element => {
    const items = [];
    for (let current = element; current; current = current.parentElement) items.push(current);
    return items;
  };
  const hidden = element => !element.getClientRects().length || ancestors(element).some(current => {
    const style = getComputedStyle(current);
    return current.hidden || current.hasAttribute('inert') || attr(current, 'aria-hidden') === 'true'
      || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  });
  const roleFor = element => {
    const explicit = attr(element, 'role').trim().toLowerCase();
    if (explicit) return roleMap[explicit] ?? '';
    const name = tag(element);
    if (name === 'button' || name === 'summary') return 'button';
    if (name === 'a' && element.hasAttribute('href')) return 'link';
    if (name === 'textarea') return 'text area';
    if (name === 'select') return 'pop up button';
    if (name !== 'input') return '';
    const type = (attr(element, 'type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox') return 'check box';
    if (type === 'radio') return 'radio button';
    if (type === 'range') return 'slider';
    return type === 'search' ? 'search field' : 'text field';
  };
  const referencedText = (element, attribute) => attr(element, attribute).trim().split(/\s+/)
    .filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const elementName = element => attr(element, 'aria-label').trim()
    || referencedText(element, 'aria-labelledby')
    || Array.from(element.labels ?? []).map(label => label.textContent ?? '').join(' ').trim()
    || (element.innerText ?? '').trim()
    || attr(element, 'title').trim()
    || attr(element, 'placeholder').trim()
    || (roleFor(element) === 'button' && typeof element.value === 'string' ? element.value : '');

  if (!document.body) return { error: 'INVALID_OBSERVATION' };
  if (Array.from(document.querySelectorAll('iframe,frame')).some(frame => !hidden(frame))) {
    return { error: 'IFRAMES_UNSUPPORTED' };
  }
  const text = document.body.innerText;
  if (typeof text !== 'string') return { error: 'INVALID_OBSERVATION' };
  if (text.length > 20000) return { error: 'OBSERVATION_TOO_LARGE' };
  const elements = [];
  const candidates = Array.from(document.querySelectorAll(selector));
  for (let ref = 0; ref < candidates.length; ref++) {
    const element = candidates[ref];
    if (hidden(element)) continue;
    const elementTag = tag(element);
    const inputType = attr(element, 'type').toLowerCase();
    const autocomplete = attr(element, 'autocomplete').toLowerCase();
    if (['password', 'hidden', 'file'].includes(inputType)
      || /(?:^|\s)(?:current-password|new-password|one-time-code|cc-\S+)(?:\s|$)/.test(autocomplete)) continue;
    const role = roleFor(element);
    if (!role) continue;
    // Decorative role wrappers inside an interactive control do not get a second target.
    if (attr(element, 'role') && !['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(elementTag)
      && ancestors(element).slice(1).some(parent => roleFor(parent))) continue;
    const name = elementName(element);
    const description = attr(element, 'aria-description') || referencedText(element, 'aria-describedby');
    const identityText = `${name} ${description} ${attr(element, 'id')} ${attr(element, 'name')}`;
    if (['text field', 'search field', 'text area', 'combo box'].includes(role)
      && /\b(?:password|passcode|one[- ]time[- ]code|security[- ]code|card[- ]number|cvv|cvc)\b/i.test(identityText)) continue;
    const disabled = element.matches(':disabled') || ancestors(element).some(current => attr(current, 'aria-disabled') === 'true');
    const readOnly = element.hasAttribute('readonly') || attr(element, 'aria-readonly') === 'true';
    const editable = !readOnly && (elementTag === 'textarea'
      || (elementTag === 'input' && ['', 'text', 'search', 'email', 'tel', 'url', 'number'].includes(inputType))
      || element.isContentEditable === true);
    const item = {
      ref, role, name,
      ...(description ? { description } : {}),
      ...((editable || readOnly) && typeof element.value === 'string' ? { value: element.value }
        : editable && element.isContentEditable === true ? { value: element.innerText ?? '' } : {}),
      ...(disabled ? { disabled: true } : {}),
      editable,
      identity: JSON.stringify({
        tag: elementTag, id: attr(element, 'id'), name: attr(element, 'name'), type: inputType,
        href: attr(element, 'href'), autocomplete, readOnly,
        checked: element.checked === true, selectedValue: elementTag === 'select' ? element.value : undefined,
      }),
    };
    if (Object.values(item).some(value => typeof value === 'string' && value.length > 20000)) {
      return { error: 'OBSERVATION_TOO_LARGE' };
    }
    elements.push(item);
    if (elements.length > 199) return { error: 'OBSERVATION_TOO_LARGE' };
  }
  return { title: document.title, url: location.href, text, candidateCount: candidates.length, elements };
}

class AdapterError extends Error {
  constructor(code, actionDispatched = false) {
    super(code);
    this.code = code;
    this.detail = code;
    // True means invocation was attempted, not proof of a physical effect.
    this.actionDispatched = actionDispatched;
  }
}
const fail = (code, actionDispatched = false) => new AdapterError(code, actionDispatched);
function sanitizedFailure(error, fallback = 'ACTION_FAILED', actionDispatched = false) {
  let message = '';
  try { if (typeof error?.message === 'string') message = error.message; } catch {}
  const code = /this\._engines\.set|_engines\.set is not a function/i.test(message) ? 'LOCATOR_ENGINE_FAILED'
    : /\bCDP\b|Debugger unattached|Session closed|Target closed|Connection closed|browser has been closed/i.test(message) ? 'CDP_CONNECTION_FAILED'
      : /timeout|timed out|deadline/i.test(message) ? 'ACTION_TIMEOUT' : fallback;
  return fail(code, actionDispatched);
}
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const captureErrors = new Set(['INVALID_OBSERVATION', 'IFRAMES_UNSUPPORTED', 'OBSERVATION_TOO_LARGE']);

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw fail('INVALID_OBSERVATION');
  if (captureErrors.has(snapshot.error)) throw fail(snapshot.error);
  if (!['title', 'url', 'text'].every(key => typeof snapshot[key] === 'string')
    || !Number.isSafeInteger(snapshot.candidateCount) || snapshot.candidateCount < 0
    || !Array.isArray(snapshot.elements) || snapshot.elements.length > 199) {
    throw fail('INVALID_OBSERVATION');
  }
  const refs = new Set();
  for (const element of snapshot.elements) {
    if (!isRecord(element) || !Number.isSafeInteger(element.ref) || element.ref < 0
      || element.ref >= snapshot.candidateCount || refs.has(element.ref)
      || !AX_ROLES.has(element.role) || typeof element.name !== 'string' || typeof element.editable !== 'boolean'
      || typeof element.identity !== 'string'
      || (element.description !== undefined && typeof element.description !== 'string')
      || (element.value !== undefined && typeof element.value !== 'string')
      || (element.disabled !== undefined && typeof element.disabled !== 'boolean')) throw fail('INVALID_OBSERVATION');
    refs.add(element.ref);
  }
  if (Object.values(snapshot).some(value => typeof value === 'string' && value.length > MAX_TEXT_LENGTH)
    || snapshot.elements.some(element => Object.values(element).some(value => typeof value === 'string' && value.length > MAX_TEXT_LENGTH))) {
    throw fail('OBSERVATION_TOO_LARGE');
  }
  const signature = JSON.stringify(snapshot);
  if (signature.length > MAX_SNAPSHOT_LENGTH) throw fail('OBSERVATION_TOO_LARGE');
  return { snapshot, signature };
}

// Escape every AX delimiter as literal text, including marker colons and initial qualifiers.
function label(value) {
  return value.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029,:()]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function serializeAX(snapshot) {
  const lines = [
    `Page title: ${JSON.stringify(snapshot.title)}`,
    `Page URL: ${JSON.stringify(snapshot.url)}`,
    `Page text: ${JSON.stringify(snapshot.text)}`,
    `${snapshot.candidateCount} AXWebArea ${label(snapshot.title)}`,
  ];
  for (const element of snapshot.elements) {
    let line = `${element.ref} ${element.role}${element.disabled ? ' (disabled)' : ''} ${label(element.name)}`;
    if (element.description !== undefined) line += `, Description: ${label(element.description)}`;
    if (element.value !== undefined) line += `, Value: ${label(element.value)}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Adapt a standard Playwright Page or Codex tab.playwright to runCuaWorkflow. */
export function createPlaywrightTarget(page) {
  if (!page || typeof page.evaluate !== 'function' || typeof page.locator !== 'function') throw fail('INVALID_PAGE');
  let registry;
  let busy = false;

  async function capture() {
    let snapshot;
    try { snapshot = await page.evaluate(captureDOM); }
    catch (error) { throw sanitizedFailure(error, 'OBSERVATION_FAILED'); }
    try { return validateSnapshot(snapshot); }
    catch (error) { throw error instanceof AdapterError ? error : fail('INVALID_OBSERVATION'); }
  }

  async function getObservation() {
    if (busy) throw fail('TARGET_BUSY');
    registry = undefined;
    busy = true;
    try {
      const captured = await capture();
      const text = serializeAX(captured.snapshot);
      if (text.length > MAX_SNAPSHOT_LENGTH) throw fail('OBSERVATION_TOO_LARGE');
      // Expose immutable copies; callers cannot alter the registry used by dispatch.
      // URL and title come from this capture, never from page-authored AX text.
      const observation = Object.freeze({
        text: captured.snapshot.text,
        // Fixed-plan postconditions can retain the legacy AX text contract.
        axText: text,
        elements: Object.freeze(Array.from(captured.snapshot.elements, element => Object.freeze({ ...element }))),
        url: captured.snapshot.url,
        title: captured.snapshot.title,
      });
      registry = captured;
      return observation;
    } finally { busy = false; }
  }

  async function getAXState() {
    return (await getObservation()).axText;
  }

  async function dispatch(ref, method, value) {
    if (busy) throw fail('TARGET_BUSY');
    if (!registry) throw fail('OBSERVATION_REQUIRED');
    const previous = registry;
    registry = undefined;
    const element = previous.snapshot.elements.find(candidate => candidate.ref === ref);
    if (!Number.isSafeInteger(ref) || ref < 0 || !element || element.disabled
      || (method === 'fill' && (!element.editable || typeof element.value !== 'string'))) throw fail('INVALID_TARGET');
    busy = true;
    try {
      const fresh = await capture();
      const current = resolveStableTarget(previous.snapshot, fresh.snapshot, ref);
      if (!current) throw fail('STALE_OBSERVATION');
      let target;
      try {
        target = page.locator(INTERACTIVE).nth(current.ref);
      } catch (error) { throw sanitizedFailure(error); }
      const expectedValue = method === 'fill' ? current.value + value : undefined;
      let actionError;
      try {
        if (method === 'click') await target.click();
        else if (method === 'fill') await target.fill(expectedValue);
        else await target.press(value);
      } catch (error) { actionError = sanitizedFailure(error, 'ACTION_FAILED', true); }
      if (method === 'fill') {
        // A timeout can occur after a successful input. Observe once, never replay.
        let outcome;
        try { outcome = await capture(); }
        catch (error) {
          if (actionError) throw actionError;
          throw fail(error instanceof AdapterError ? error.code : 'OBSERVATION_FAILED', true);
        }
        const expected = { ...fresh.snapshot, elements: fresh.snapshot.elements.map(candidate =>
          candidate.ref === current.ref ? { ...candidate, value: expectedValue } : candidate) };
        if (!resolveStableTarget(expected, outcome.snapshot, current.ref)) {
          throw actionError ?? fail('INPUT_VALUE_MISMATCH', true);
        }
      } else if (actionError) throw actionError;
    } finally { busy = false; }
  }

  return {
    getAXState,
    getObservation,
    click: ref => dispatch(ref, 'click'),
    async typeText(ref, text) {
      if (typeof text !== 'string') throw fail('INVALID_ARGUMENT');
      return dispatch(ref, 'fill', text);
    },
    async pressKey(ref, key) {
      if (typeof key !== 'string' || !key.trim()) throw fail('INVALID_ARGUMENT');
      return dispatch(ref, 'press', key);
    },
    async scroll(ref, direction, distance = 1) {
      if (!['up', 'down'].includes(direction) || distance !== 1) throw fail('UNSUPPORTED_SCROLL');
      return dispatch(ref, 'press', direction === 'down' ? 'PageDown' : 'PageUp');
    },
  };
}
