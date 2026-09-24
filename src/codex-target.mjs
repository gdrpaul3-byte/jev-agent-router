import { createPlaywrightTarget } from './playwright.mjs';
import { parseAX, isProtectedElement } from './cua.mjs';
import { resolveStableTarget, normalizeText, isProtectedTarget } from './observation.mjs';

const INTERACTIVE = 'a[href],button,input,textarea,select,[role],summary';
const editableRoles = new Set(['text field', 'search field', 'search text field', 'text area', 'text entry area', 'combo box']);
const error = (code, actionDispatched = false) => Object.assign(new Error(code), { code, detail: code, actionDispatched });
const knownCodes = new Set(['LOCATOR_ENGINE_FAILED', 'CDP_CONNECTION_FAILED', 'ACTION_TIMEOUT', 'OBSERVATION_FAILED',
  'INVALID_OBSERVATION', 'OBSERVATION_TOO_LARGE', 'IFRAMES_UNSUPPORTED', 'INVALID_PAGE', 'STALE_OBSERVATION']);
function sanitizedFailure(cause, fallback = 'ACTION_FAILED', actionDispatched = false) {
  let message = '', known;
  try { message = typeof cause?.message === 'string' ? cause.message : ''; known = knownCodes.has(cause?.code) ? cause.code : undefined; } catch {}
  const code = known ?? (/this\._engines\.set|_engines\.set is not a function/i.test(message) ? 'LOCATOR_ENGINE_FAILED'
    : /\bCDP\b|Debugger unattached|Session closed|Target closed|Connection closed|browser has been closed/i.test(message) ? 'CDP_CONNECTION_FAILED'
      : /timeout|timed out|deadline/i.test(message) ? 'ACTION_TIMEOUT' : fallback);
  return error(code, actionDispatched);
}
const validURL = value => {
  try { const url = new URL(value); return typeof value === 'string' && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};
function nativeLinkLocation(value, pageURL) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const page = new URL(pageURL);
    let location;
    if (/^https?:\/\//i.test(value)) location = new URL(value);
    else if (/^\/(?!\/)/.test(value)) location = new URL(value, pageURL);
    else {
      // Native AX may display the current host without its scheme or www.
      // Do not mistake arbitrary text/JavaScript for a navigation destination.
      location = new URL(`${page.protocol}//${value}`);
      if (location.hostname.replace(/^www\./, '') !== page.hostname.replace(/^www\./, '') || location.port !== page.port) return undefined;
    }
    return ['http:', 'https:'].includes(location.protocol) && !location.username && !location.password ? location.href : undefined;
  } catch { return undefined; }
}

function createNativeTarget(tab, backendReason) {
  if (!tab || !['getAXState', 'url', 'title', 'click'].every(method => typeof tab[method] === 'function')) throw error('INVALID_PAGE');
  let registry, busy = false;
  async function capture() {
    let axText, url, title, parsed;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const [beforeURL, beforeTitle] = await Promise.all([tab.url(), tab.title()]);
        axText = await tab.getAXState({ emit: false, disableDiffing: true });
        [url, title] = await Promise.all([tab.url(), tab.title()]);
        if (beforeURL === url && beforeTitle === title) break;
        // Navigation may finish during a read. Discard only this incoherent
        // snapshot and recapture once; physical actions are never retried.
        if (attempt === 1) throw error('STALE_OBSERVATION');
      }
    } catch (cause) { throw sanitizedFailure(cause, 'OBSERVATION_FAILED'); }
    if (typeof axText !== 'string' || !validURL(url) || typeof title !== 'string') throw error('INVALID_OBSERVATION');
    if (axText.length > 100000) throw error('OBSERVATION_TOO_LARGE');
    try { parsed = parseAX(axText); } catch { throw error('INVALID_OBSERVATION'); }
    if (parsed.elements.length > 199) throw error('OBSERVATION_TOO_LARGE');
    const lines = axText.split(/\r?\n/);
    const linesByRef = new Map(lines.map(line => [Number(/^\s*(\d+)\s/.exec(line)?.[1]), line]));
    const protectedRefs = new Set();
    const elements = parsed.elements.map(original => {
      const protectedField = isProtectedElement(original) || isProtectedTarget(original);
      if (protectedField) protectedRefs.add(original.ref);
      const line = linesByRef.get(original.ref) ?? '';
      const rawValue = /(?:^|,\s*)Value: ?(.*)$/.exec(line)?.[1];
      const ambiguousValue = rawValue !== undefined && /,\s*(?:Description|Value|Title|Label|Help|ID|URL|Secondary Actions|Enabled|Disabled|Role|Placeholder):/.test(rawValue);
      const rawURL = /(?:^|,\s*)URL: ?(.*)$/.exec(line)?.[1];
      const hasUnambiguousURL = rawURL !== undefined && !/,\s*(?:Description|Value|Title|Label|Help|ID|URL|Secondary Actions|Enabled|Disabled|Role|Placeholder):/.test(rawURL);
      const readOnly = /\((?:[^)]*\b)?read[ -]?only\b[^)]*\)/i.test(line);
      const linkLocation = original.role === 'link' ? nativeLinkLocation(hasUnambiguousURL ? rawURL : original.value, url) : undefined;
      const nativeID = /(?:^|,\s*)ID: ?(.*?)(?=,\s*(?:Description|Value|Title|Label|Help|ID|URL|Secondary Actions|Enabled|Disabled|Role|Placeholder):|$)/.exec(line)?.[1].trim();
      return Object.freeze({ ...original, editable: editableRoles.has(original.role) && !protectedField && !readOnly,
        ...(editableRoles.has(original.role) && rawValue !== undefined ? { value: ambiguousValue ? undefined : rawValue } : {}),
        ...(hasUnambiguousURL ? { href: rawURL } : {}),
        ...(linkLocation && !protectedField ? { identity: JSON.stringify({ source: 'native-ax-link', href: linkLocation, ...(nativeID ? { id: nativeID } : {}) }) } : {}),
        ...(protectedField ? { protected: true, disabled: true, name: '[protected control]', description: undefined, value: undefined, href: undefined } : {}) });
    });
    let protectedContinuation = false;
    const text = lines.map(line => {
      const ref = /^\s*(\d+)\s/.exec(line)?.[1];
      if (ref !== undefined) protectedContinuation = protectedRefs.has(Number(ref));
      return protectedContinuation ? ref !== undefined ? `${ref} secure text field [protected control]` : '' : line;
    }).join('\n');
    return Object.freeze({ text, axText: text, url, title, elements: Object.freeze(elements) });
  }
  async function getObservation() {
    if (busy) throw error('TARGET_BUSY');
    registry = undefined; busy = true;
    try { registry = await capture(); return registry; }
    finally { busy = false; }
  }
  async function dispatch(ref, method, text) {
    if (busy) throw error('TARGET_BUSY');
    if (!registry) throw error('OBSERVATION_REQUIRED');
    const previous = registry; registry = undefined;
    const element = previous.elements.find(candidate => candidate.ref === ref);
    if (!Number.isSafeInteger(ref) || !element || element.disabled || element.protected
      || (method === 'typeText' && (!element.editable || typeof element.value !== 'string'))) throw error('INVALID_TARGET');
    busy = true;
    try {
      const fresh = await capture();
      const current = resolveStableTarget(previous, fresh, ref);
      if (!current) throw error('STALE_OBSERVATION');
      const expectedValue = method === 'typeText' ? current.value + text : undefined;
      if (method === 'typeText' && typeof tab.setValue !== 'function' && typeof tab.typeText !== 'function') throw error('INVALID_PAGE');
      let actionError;
      try {
        if (method === 'click') await tab.click(current.ref);
        else if (typeof tab.setValue === 'function') await tab.setValue(current.ref, expectedValue);
        else await tab.typeText(current.ref, text);
      } catch (cause) { actionError = sanitizedFailure(cause, 'ACTION_FAILED', true); }
      if (method === 'typeText') {
        let after;
        try { after = await capture(); }
        catch (cause) { throw actionError ?? sanitizedFailure(cause, 'OBSERVATION_FAILED', true); }
        const observed = after.elements.find(candidate => candidate.ref === current.ref);
        // This is outcome verification only; a changed/unknown result is never replayed.
        if (after.url !== fresh.url || after.title !== fresh.title || !observed || observed.disabled || observed.protected
          || observed.role !== current.role || normalizeText(observed.name) !== normalizeText(current.name)
          || observed.description !== current.description || observed.value !== expectedValue) {
          throw actionError ?? error('INPUT_VALUE_MISMATCH', true);
        }
      } else if (actionError) throw actionError;
    } finally { busy = false; }
  }
  return Object.freeze({ backend: 'native', ...(backendReason ? { backendReason } : {}), getObservation,
    getAXState: async () => (await getObservation()).axText,
    click: ref => dispatch(ref, 'click'),
    typeText(ref, text) {
      if (typeof text !== 'string') throw error('INVALID_ARGUMENT');
      return dispatch(ref, 'typeText', text);
    },
  });
}

const comparableRole = role => ({ 'text field': 'textbox', 'text area': 'textbox', 'text entry area': 'textbox',
  'search field': 'searchbox', 'search text field': 'searchbox', 'combo box': 'combobox', 'pop up button': 'combobox',
  'check box': 'checkbox', 'radio button': 'radio', 'menu item': 'menuitem' })[role] ?? role;
const sameSemanticTarget = (left, right) => comparableRole(left.role) === comparableRole(right.role)
  && normalizeText(left.name) === normalizeText(right.name);
const meaningfulDescription = element => {
  const description = normalizeText(element.description);
  // Native AX commonly uses Description as the accessible name. That duplicate
  // is not independent help text; compare descriptions when both add meaning.
  return description && description !== normalizeText(element.name) ? description : undefined;
};

function createNativeActionsTarget(tab) {
  const dom = createPlaywrightTarget(tab?.playwright);
  const native = createNativeTarget(tab);
  let registry, busy = false;
  async function getObservation() {
    if (busy) throw error('TARGET_BUSY');
    registry = undefined; busy = true;
    try { registry = await dom.getObservation(); return registry; }
    finally { busy = false; }
  }
  async function dispatch(ref, method, text) {
    if (busy) throw error('TARGET_BUSY');
    if (!registry) throw error('OBSERVATION_REQUIRED');
    const previous = registry; registry = undefined;
    const selected = previous.elements.find(element => element.ref === ref);
    if (!Number.isSafeInteger(ref) || !selected || selected.disabled || isProtectedTarget(selected)
      || (method === 'typeText' && !selected.editable)) throw error('INVALID_TARGET');
    busy = true;
    try {
      const fresh = await dom.getObservation();
      const current = resolveStableTarget(previous, fresh, ref);
      if (!current) throw error('STALE_OBSERVATION');
      if (method === 'typeText') return await dom.typeText(current.ref, text);
      if (!normalizeText(current.name) || fresh.elements.filter(element => sameSemanticTarget(element, current)).length !== 1) throw error('STALE_OBSERVATION');
      const ax = await native.getObservation();
      if (ax.url !== fresh.url || ax.title !== fresh.title) throw error('STALE_OBSERVATION');
      const matches = ax.elements.filter(element => sameSemanticTarget(element, current));
      if (matches.length !== 1 || matches[0].disabled || isProtectedTarget(matches[0])) throw error('STALE_OBSERVATION');
      const mapped = matches[0];
      const domDescription = meaningfulDescription(current), nativeDescription = meaningfulDescription(mapped);
      if (domDescription && nativeDescription && domDescription !== nativeDescription) throw error('STALE_OBSERVATION');
      if (current.value !== undefined && mapped.value !== undefined && current.value !== mapped.value) throw error('STALE_OBSERVATION');
      let identity;
      try { identity = JSON.parse(current.identity); } catch { throw error('STALE_OBSERVATION'); }
      if (typeof identity?.href === 'string' && mapped.href !== undefined) {
        try { if (new URL(identity.href, fresh.url).href !== new URL(mapped.href, ax.url).href) throw error('STALE_OBSERVATION'); }
        catch { throw error('STALE_OBSERVATION'); }
      }
      // This ref comes from the just-read coherent native snapshot. Dispatch
      // immediately after the unique DOM/native mapping, with no saved AX ref
      // or second full-page read that would churn refs on animated pages.
      try { await tab.click(mapped.ref); }
      catch (cause) { throw sanitizedFailure(cause, 'ACTION_FAILED', true); }
    } finally { busy = false; }
  }
  return Object.freeze({ backend: 'native-actions', getObservation,
    getAXState: async () => (await getObservation()).axText,
    click: ref => dispatch(ref, 'click'),
    typeText(ref, text) {
      if (typeof text !== 'string') throw error('INVALID_ARGUMENT');
      return dispatch(ref, 'typeText', text);
    },
  });
}

/** Select a healthy driver before any action; never replay an action on another driver. */
export async function createCodexTarget(tab, { backend = 'auto', preflightTimeoutMs = 5000 } = {}) {
  if (!['auto', 'dom', 'native', 'native-actions'].includes(backend) || !Number.isFinite(preflightTimeoutMs)
    || preflightTimeoutMs <= 0 || preflightTimeoutMs > 30000) throw error('INVALID_ARGUMENT');
  if (backend === 'native') return createNativeTarget(tab);
  if (backend === 'native-actions') return createNativeActionsTarget(tab);
  const target = createPlaywrightTarget(tab?.playwright);
  let timer;
  try {
    const preflight = async () => {
      const observation = await target.getObservation();
      const roles = { button: 'button', link: 'link', 'text field': 'textbox', 'search field': 'searchbox', 'text area': 'textbox',
        'check box': 'checkbox', 'radio button': 'radio', 'combo box': 'combobox', 'menu item': 'menuitem', tab: 'tab' };
      const unique = observation.elements.find(element => !element.disabled && roles[element.role] && normalizeText(element.name)
        && observation.elements.filter(candidate => candidate.role === element.role && normalizeText(candidate.name) === normalizeText(element.name)).length === 1);
      if (unique && typeof tab.playwright.getByRole === 'function') {
        await tab.playwright.getByRole(roles[unique.role], { name: normalizeText(unique.name), exact: true }).getAttribute('id');
      } else {
        const element = observation.elements.find(candidate => !candidate.disabled);
        if (element) await tab.playwright.locator(INTERACTIVE).nth(element.ref).getAttribute('id');
      }
    };
    await Promise.race([preflight(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(error('ACTION_TIMEOUT')), preflightTimeoutMs);
    })]);
  } catch (cause) {
    const failure = sanitizedFailure(cause, 'OBSERVATION_FAILED');
    if (backend === 'auto' && failure.code === 'LOCATOR_ENGINE_FAILED') return createNativeTarget(tab, failure.code);
    throw failure;
  } finally { clearTimeout(timer); }
  return Object.freeze({ backend: 'dom', ...target });
}
