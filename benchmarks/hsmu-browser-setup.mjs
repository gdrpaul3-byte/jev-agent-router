// Identical, unmeasured homepage preparation for both arms; only observed popup close links.
const HOME = 'https://www.hsmu.ac.kr/web/main/index.do';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function capturePopups() {
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none';
  return JSON.stringify({ url: location.href, popups: Array.from(document.querySelectorAll('div.modalpopup')).filter(visible).map(popup => {
    const closes = Array.from(popup.querySelectorAll('a.close')).filter(visible);
    return { id: popup.id, zIndex: Number(getComputedStyle(popup).zIndex) || 0, closeCount: closes.length,
      href: closes[0]?.getAttribute('href'), label: closes[0]?.textContent?.trim() };
  }) });
}
export async function prepareHsmuHome(page, onClose = () => {}) {
  async function observe() {
    const text = await page.evaluate(capturePopups);
    if (typeof text !== 'string' || text.length > 16000) fail('INVALID_OBSERVATION');
    let value; try { value = JSON.parse(text); } catch { fail('INVALID_OBSERVATION'); }
    if (value?.url !== HOME) fail('OUT_OF_SCOPE');
    if (!Array.isArray(value.popups) || value.popups.length > 8 || value.popups.some(popup =>
      !/^pop_\d+$/.test(popup.id) || !Number.isFinite(popup.zIndex) || popup.closeCount !== 1 || popup.href !== '#' || popup.label !== '닫기')
      || new Set(value.popups.map(popup => popup.id)).size !== value.popups.length) fail('INVALID_OBSERVATION');
    return value.popups;
  }
  const closedPopupIds = [];
  for (let count = 0; count <= 8; count++) {
    const popups = await observe();
    if (!popups.length) return { closedPopupIds, modelRequests: 0, includedInTaskTimer: false };
    if (count === 8) fail('VERIFICATION_FAILED');
    const popup = popups.sort((a, b) => b.zIndex - a.zIndex)[0];
    // ID, unique close link, label and href were just read; no page-authored code is evaluated.
    await page.locator(`div.modalpopup[id="${popup.id}"] a.close`).click({ timeout: 5000 });
    if ((await observe()).some(item => item.id === popup.id)) fail('VERIFICATION_FAILED');
    closedPopupIds.push(popup.id); onClose({ popupId: popup.id, count: closedPopupIds.length });
  }
}
