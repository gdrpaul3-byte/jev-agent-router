// Normalizes text copied verbatim from official Claude in Chrome tool results into the bridge's
// observation envelope. The grammar follows the serializer of Claude in Chrome 1.0.94
// (assets/accessibility-tree.js) as installed and observed on 2026-09-24. It is not a published
// contract, so every line that does not fit it stops instead of being guessed.
//
// Serializer facts: every element line has a ref; only select options are printed without one.
// Names have whitespace collapsed, are cut at 100 characters and escape only `"` as `\"`.
// role, href, type and placeholder are printed raw, in that order, so page-controlled values can
// contain quotes or even newlines. A newline can forge a well-formed element line, which is why
// authorization also checks the target through read_page ref_id (see parseRefCheck).
const MAX_RAW_CHARS = 400000;
const MAX_CANDIDATES = 200;
const MAX_ATTRIBUTE_CHARS = 300;
const ROLE = '[A-Za-z][A-Za-z0-9_-]{0,63}(?: [A-Za-z][A-Za-z0-9_-]{0,63}){0,7}';
const NAME = '"((?:\\\\"|[^"])*)"';
const ELEMENT = new RegExp(`^( *)(${ROLE})(?: ${NAME})? \\[(ref_[0-9]{1,9})\\](?: href="([^"]*)")?(?: type="([^"]*)")?(?: placeholder="(.*)")?$`);
const OPTION = /^ +option(?: "(?:\\"|[^"])*")?(?: \(selected\))?(?: value="(?:\\"|[^"])*")?$/;
const EDITABLE = new Set(['textbox', 'searchbox']);
const NO_TEXT = 'No text content found. Page may contain only images, videos, or canvas-based content.';
// Claude in Chrome appends this block after the last tool output; it lists every tab in the group.
const TAB_CONTEXT_FOOTER = /(?:^|\n)Tab Context:\n(?:- Executed on tabId: \d+\n)?- Available tabs:(?:\n|$)/;
const stop = reason => ({ status: 'needs_host', reason });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= MAX_RAW_CHARS;
const lines = raw => raw.replace(/\r\n?/g, '\n');
// Cut by code point so an astral character is never split into a lone surrogate.
const clip = value => { const points = Array.from(value); return points.length > MAX_ATTRIBUTE_CHARS ? `${points.slice(0, MAX_ATTRIBUTE_CHARS).join('')}…` : value; };
const describe = attributes => Object.entries(attributes).map(([key, value]) => `${key}=${clip(value)}`).join('; ');
const luhn = digits => [...digits].reverse().reduce((sum, digit, index) => sum + (index % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][digit] : Number(digit)), 0) % 10 === 0;
const CREDENTIAL = /\b(?:password|passcode|pin|one[- ]time[- ]code|otp|security[- ]code|card[- ]number|cvv|cvc)\b|비밀번호|인증번호|보안코드|카드번호/i;
// A show/hide password control means a field may display a password as plain text under its value name.
// Matched within one line and without word boundaries: page text can join a label to the next word. False
// positives only withhold fields.
const REVEAL = /(?:show|hide|reveal|toggle|display)[^"\n]{0,20}password|password[^"\n]{0,3}(?:show|hide|reveal)|비밀번호[^"\n]{0,4}(?:보기|보이기|표시|숨기기|숨김|감추기)/i;

/**
 * A value that looks like a one-time code (6–8 digits, optionally grouped by spaces) or a card number
 * (Luhn-valid 12–19 digits with space, dot or dash separators). Dates and postal codes with dashes are not codes.
 */
export function secretShaped(value) {
  if (typeof value !== 'string') return false;
  if (/^\d(?: ?\d){5,7}$/.test(value)) return true;
  const digits = /^[\d .-]+$/.test(value) ? value.replace(/[ .-]/g, '') : '';
  return /^\d{12,19}$/.test(digits) && luhn(digits);
}

/**
 * One predicate for the parser and the bridge: such elements never reach the model. Text fields are named
 * by their value when they have no label, so the name and an observed value are checked for secret-shaped
 * content. A value marked valueSource "tool_report" is the host's own plan text, which JEV already receives.
 * A revealed password or a short code without such a shape cannot be recognized from the tool text alone.
 */
export function sensitiveElement(element) {
  return element.protected === true || /secure|password|protected/i.test(element.role)
    || (/text|search|combo|spin/i.test(element.role) && (CREDENTIAL.test(`${element.name} ${element.description ?? ''}`)
      || secretShaped(element.name) || (element.valueSource !== 'tool_report' && secretShaped(element.value))));
}

/** True when the page offers a show/hide password control; its editable fields are then withheld. */
export function revealsPassword(elements, pageText = '') {
  // A label-wrapped checkbox is printed as `checkbox "on"`, so its "Show password" text is only in the page text.
  return REVEAL.test(pageText) || elements.some(element => typeof element?.name === 'string' && REVEAL.test(element.name));
}

function parseElementLine(line) {
  const match = ELEMENT.exec(line);
  // Two `" [ref_` markers mean a quote-escaped name or raw attribute could be split two ways.
  if (!match || line.split('" [ref_').length > 2) return null;
  const [, indent, role, rawName, ref, href, type, placeholder] = match;
  if (rawName !== undefined && (/\\$/.test(rawName) || rawName.includes('\\" [ref_'))) return null;
  const attributes = Object.fromEntries(Object.entries({ href, type, placeholder }).filter(([, value]) => value !== undefined));
  return { depth: indent.length, ref, role, name: rawName === undefined ? '' : rawName.replace(/\\"/g, '"'), attributes };
}

/** Parses read_page output (optionally with the batch label). Options are skipped and counted. */
export function parseReadPage(raw) {
  if (!text(raw)) return stop('READ_PAGE_INVALID');
  const elements = [], refs = new Set();
  let viewport, skipped = 0;
  for (const line of lines(raw).replace(/^\[read_page\] ?/, '').split('\n')) {
    if (!line.trim() || line === '(empty page)') continue;
    const size = /^Viewport: (\d{1,5})x(\d{1,5})$/.exec(line);
    if (size) { if (viewport) return stop('READ_PAGE_UNPARSED'); viewport = { width: Number(size[1]), height: Number(size[2]) }; continue; }
    if (OPTION.test(line)) { skipped++; continue; }
    const element = parseElementLine(line);
    if (!element) return stop('READ_PAGE_UNPARSED');
    if (refs.has(element.ref)) return stop('READ_PAGE_DUPLICATE_REF');
    refs.add(element.ref);
    const { depth, ...copied } = element;
    elements.push(copied);
  }
  if (!viewport) return stop('READ_PAGE_UNPARSED');
  return { status: 'parsed', elements, viewport, skippedWithoutRef: skipped };
}

/**
 * read_page with ref_id prints the referenced element itself as its first line. That line binds the
 * ref to the real element, so a line forged into the page listing cannot borrow another element's ref.
 */
export function parseRefCheck(raw, ref) {
  if (!text(raw)) return stop('REF_CHECK_REQUIRED');
  const first = lines(raw).replace(/^\[read_page\] ?/, '').split('\n')[0];
  // The tool's own error for this removed element (standalone, or as a failed batch action): the target is gone.
  const gone = /^(?:actions\[\d+\] \(read_page\) failed: )?(?:Error: )?Element with ref_id '([^']*)' (?:not found|no longer exists)\./.exec(first);
  if (gone) return stop(gone[1] === ref ? 'STALE_TARGET' : 'TARGET_BINDING_MISMATCH');
  const element = parseElementLine(first);
  if (!element || element.depth !== 0 || element.ref !== ref) return stop('TARGET_BINDING_MISMATCH');
  const description = describe(element.attributes);
  return { status: 'parsed', element: { ref, role: element.role, name: element.name, ...(description ? { description } : {}) } };
}

/** Reads the one-line JSON object that tabs_context_mcp prints before its human summary. */
export function parseTabsContext(raw, tabId) {
  if (!text(raw) || !Number.isSafeInteger(tabId) || tabId < 0) return stop('TAB_CONTEXT_INVALID');
  const line = lines(raw).split('\n').map(item => item.replace(/^\[tabs_context_mcp\] ?/, '')).find(item => item.startsWith('{'));
  let context;
  try { context = JSON.parse(line); } catch { return stop('TAB_CONTEXT_INVALID'); }
  if (!record(context) || !Array.isArray(context.availableTabs)) return stop('TAB_CONTEXT_INVALID');
  const tabs = context.availableTabs.filter(tab => record(tab) && tab.tabId === tabId);
  if (tabs.length > 1) return stop('TAB_CONTEXT_INVALID');
  if (!tabs.length) return stop('TAB_NOT_FOUND');
  const [tab] = tabs;
  if (typeof tab.url !== 'string' || (tab.title !== undefined && typeof tab.title !== 'string')) return stop('TAB_CONTEXT_INVALID');
  return { status: 'parsed', tab: { id: tabId, url: tab.url, ...(tab.title !== undefined ? { title: tab.title } : {}) } };
}

/** get_page_text prints `Title: document.title`, `URL: location.href`, the source element and `---`. */
export function parsePageText(raw) {
  if (!text(raw)) return stop('PAGE_TEXT_INVALID');
  const normalized = lines(raw).replace(/^\[get_page_text\] ?/, '');
  // The footer carries other tabs' titles and URLs; it must never become page text or completion evidence.
  if (TAB_CONTEXT_FOOTER.test(normalized)) return stop('PAGE_TEXT_INVALID');
  const header = /^Title: ([^\n]*)\nURL: ([^\n]*)\n(?:Source element: [^\n]*\n)?---\n/.exec(normalized);
  // The tool reports this instead of a header when its chosen container holds under 10 characters,
  // either alone or as a failed batch action ("actions[N] (get_page_text) failed: …").
  if (!header && normalized.includes(NO_TEXT)) return stop('PAGE_TEXT_UNAVAILABLE');
  return { status: 'parsed', text: header ? normalized.slice(header[0].length) : normalized, ...(header ? { title: header[1], url: header[2] } : {}) };
}

/**
 * Builds the bridge envelope from one observation batch. `readPage` must come from read_page with
 * filter "interactive". `observedAtEpochMs` is the capture time when the host knows it (the CLI uses
 * the files' write time); otherwise the call time is used and the host attests freshness itself.
 * Protected fields are omitted and counted, never forwarded.
 */
export function normalizeClaudeObservation(raw, { now = Date.now } = {}) {
  if (!record(raw) || (raw.observedAtEpochMs !== undefined && (!Number.isSafeInteger(raw.observedAtEpochMs) || raw.observedAtEpochMs < 0))) return stop('RAW_OBSERVATION_INVALID');
  const tab = parseTabsContext(raw.tabsContext, raw.tabId);
  if (tab.status !== 'parsed') return tab;
  const page = parseReadPage(raw.readPage);
  if (page.status !== 'parsed') return page;
  const body = parsePageText(raw.pageText);
  if (body.status !== 'parsed') return body;
  // Observed live: a click can navigate between reads of one batch. Read tabs_context, then read_page, then
  // get_page_text; a header that no longer matches the tab metadata means the batch mixed two pages.
  // Chrome trims the tab title and caps it at 4096 characters; an empty document.title is shown as a
  // URL-derived tab title, so only a non-empty trimmed title is compared.
  const title = value => value.trim().slice(0, 4096);
  if (body.url === undefined || body.url !== tab.tab.url
      || (tab.tab.title !== undefined && title(body.title) !== '' && title(body.title) !== title(tab.tab.title))) return stop('OBSERVATION_INCONSISTENT');
  const elements = [], reveal = revealsPassword(page.elements, body.text);
  let protectedCount = 0;
  for (const { ref, role, name, attributes } of page.elements) {
    const description = describe(attributes);
    const element = { ref, role, name, ...(description ? { description } : {}), ...(EDITABLE.has(role) ? { editable: true } : {}), visible: true };
    if (/^(?:password|hidden)$/i.test(attributes.type ?? '') || name === '[value redacted]' || (reveal && element.editable)
        || sensitiveElement({ ...element, description: Object.values(attributes).join(' ') }) || sensitiveElement(element)) { protectedCount++; continue; }
    elements.push(element);
  }
  if (elements.length > MAX_CANDIDATES) return stop('TOO_MANY_CANDIDATES');
  return { status: 'observed', observation: { source: 'claude-in-chrome', observedAtEpochMs: raw.observedAtEpochMs ?? now(), tab: tab.tab, text: body.text, elements },
    omitted: { protected: protectedCount, withoutRef: page.skippedWithoutRef }, viewport: page.viewport };
}
