import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareHsmuHome } from '../benchmarks/hsmu-browser-setup.mjs';

const home = 'https://www.hsmu.ac.kr/web/main/index.do';
const popup = (id, zIndex = 1) => ({ id, zIndex, closeCount: 1, href: '#', label: '닫기' });
function fixture(initial, { remains = false, clickError = false } = {}) {
  let popups = initial.map(value => ({ ...value })); const events = [];
  const page = {
    async evaluate(callback) { assert.equal(callback.name, 'capturePopups'); events.push(['observe']); return JSON.stringify({ url: home, popups }); },
    locator(selector) {
      const match = /^div\.modalpopup\[id="(pop_\d+)"\] a\.close$/.exec(selector); assert.ok(match);
      return { async click(options) {
        assert.deepEqual(options, { timeout: 5000 }); events.push(['click', match[1]]);
        if (clickError) throw new Error('ACTION_TIMEOUT');
        if (!remains) popups = popups.filter(value => value.id !== match[1]);
      } };
    },
  };
  return { page, events };
}

test('closes only freshly observed unique homepage popups in highest z-index order before the task timer', async () => {
  const f = fixture([popup('pop_172', 2), popup('pop_200', 9), popup('pop_175', 3), popup('pop_199', 8)]), notifications = [];
  const result = await prepareHsmuHome(f.page, event => notifications.push(event));
  assert.deepEqual(result, { closedPopupIds: ['pop_200', 'pop_199', 'pop_175', 'pop_172'], modelRequests: 0, includedInTaskTimer: false });
  assert.deepEqual(f.events.filter(([kind]) => kind === 'click').map(([, id]) => id), result.closedPopupIds);
  assert.equal(notifications.length, 4);
  for (const [index, event] of f.events.entries()) if (event[0] === 'click') {
    assert.equal(f.events[index - 1][0], 'observe'); assert.equal(f.events[index + 1][0], 'observe');
  }
});

test('ambiguous links, wrong label/href, invalid IDs, duplicates, oversized data and wrong origin cannot click', async () => {
  const invalid = [
    { url: home, popups: [{ ...popup('pop_1'), closeCount: 2 }] },
    { url: home, popups: [{ ...popup('pop_1'), href: 'https://other.test' }] },
    { url: home, popups: [{ ...popup('pop_1'), label: '승인' }] },
    { url: home, popups: [popup('pop_1"],button')] },
    { url: home, popups: [popup('pop_1'), popup('pop_1')] },
    { url: home, popups: Array.from({ length: 9 }, (_, i) => popup(`pop_${i}`)) },
    { url: 'https://other.test/', popups: [] },
  ];
  for (const value of [...invalid.map(JSON.stringify), '{malformed', 'x'.repeat(16001)]) {
    const page = { evaluate: async () => value, locator: () => assert.fail('No locator for invalid preparation evidence') };
    await assert.rejects(prepareHsmuHome(page), /INVALID_OBSERVATION|OUT_OF_SCOPE/);
  }
});

test('a timeout or still-visible popup stops after one physical attempt; cap permits exactly eight successful closes', async () => {
  for (const options of [{ clickError: true }, { remains: true }]) {
    const f = fixture([popup('pop_1')], options);
    await assert.rejects(prepareHsmuHome(f.page), /ACTION_TIMEOUT|VERIFICATION_FAILED/);
    assert.equal(f.events.filter(([kind]) => kind === 'click').length, 1);
  }
  const f = fixture(Array.from({ length: 8 }, (_, i) => popup(`pop_${i}`, i)));
  assert.equal((await prepareHsmuHome(f.page)).closedPopupIds.length, 8);
  assert.deepEqual(await prepareHsmuHome(f.page), { closedPopupIds: [], modelRequests: 0, includedInTaskTimer: false });
});

test('actual popup capture crosses the site transport as a JSON primitive and excludes hidden popups', async () => {
  const close = { textContent: ' 닫기 ', display: 'block', getClientRects: () => [{}], getAttribute: () => '#' };
  const shown = { id: 'pop_200', display: 'block', zIndex: '900', getClientRects: () => [{}], querySelectorAll: () => [close] };
  const hidden = { ...shown, id: 'pop_199', display: 'none', getClientRects: () => [] };
  let visible = true, clicks = 0;
  const page = {
    async evaluate(callback) {
      const value = runInNewContext(`(${callback.toString()})()`, { document: { querySelectorAll: () => visible ? [shown, hidden] : [] },
        location: { href: home }, getComputedStyle: element => ({ display: element.display, zIndex: element.zIndex }) });
      assert.equal(typeof value, 'string'); return value;
    },
    locator(selector) { assert.equal(selector, 'div.modalpopup[id="pop_200"] a.close'); return { async click() { clicks++; visible = false; } }; },
  };
  assert.deepEqual((await prepareHsmuHome(page)).closedPopupIds, ['pop_200']); assert.equal(clicks, 1);
});
