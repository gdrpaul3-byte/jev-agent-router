/** Normalize rendered labels, including line breaks and nonbreaking spaces. */
export const normalizeText = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Shared protection rule for filtering observations as well as dispatch checks. */
export const isProtectedTarget = element => !record(element) || element.protected === true
  || /secure|password|protected/i.test(element.role)
  || (/text|search|combo/.test(element.role) && /\b(?:password|passcode|one[- ]?time[- ]?code|security[- ]?code|card[- ]?number|cvv|cvc|otp)\b|카드\s*번호|보안\s*코드|비밀\s*번호|일회용\s*(?:인증\s*)?(?:번호|코드)|인증\s*번호/i.test(`${element.name} ${element.description ?? ''}`));
const protectedTarget = element => element.disabled === true || isProtectedTarget(element);
const targetKey = element => JSON.stringify([element.identity, element.role, normalizeText(element.name),
  element.description === undefined ? undefined : normalizeText(element.description)]);
const validElements = observation => record(observation) && Array.isArray(observation.elements)
  && observation.elements.every(element => record(element) && Number.isSafeInteger(element.ref) && element.ref >= 0
    && typeof element.role === 'string' && typeof element.name === 'string')
  && new Set(observation.elements.map(element => element.ref)).size === observation.elements.length;
const validURL = value => {
  try { const url = new URL(value); return typeof value === 'string' && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

/**
 * Revalidate a single host-observed target, allowing unrelated content/ref drift.
 * URL/title must be native metadata supplied by the adapter, never parsed from
 * page text. An adapter without identities retains exact-snapshot semantics.
 */
export function resolveStableTarget(before, after, ref) {
  try {
    if (!validElements(before) || !validElements(after) || !Number.isSafeInteger(ref)) return null;
    const prior = before.elements.find(element => element.ref === ref);
    if (!prior || protectedTarget(prior)) return null;
    if (typeof prior.identity !== 'string' || !prior.identity) {
      if (JSON.stringify(before) !== JSON.stringify(after)) return null;
      const current = after.elements.find(element => element.ref === ref);
      return current && !protectedTarget(current) ? current : null;
    }
    if (!validURL(before.url) || before.url !== after.url || typeof before.title !== 'string' || before.title !== after.title) return null;
    const key = targetKey(prior);
    const previousMatches = before.elements.filter(element => targetKey(element) === key);
    const currentMatches = after.elements.filter(element => targetKey(element) === key);
    if (previousMatches.length !== 1 || currentMatches.length !== 1) return null;
    const current = currentMatches[0];
    if (protectedTarget(current) || prior.value !== current.value || prior.editable !== current.editable
      || (prior.disabled === true) !== (current.disabled === true)
      || (prior.protected === true) !== (current.protected === true)) return null;
    return current;
  } catch { return null; }
}
