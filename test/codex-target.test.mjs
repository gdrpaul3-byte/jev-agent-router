import test from 'node:test';
import assert from 'node:assert/strict';

const load = async () => {
  try { return await import('../src/codex-target.mjs'); }
  catch { assert.fail('Codex driver selection must be implemented'); }
};
function fakeTab() {
  const state = { ax: '0 AXWebArea Fixture\n7 button Continue\n8 search text field Search, Value: old ',
    domElements: [{ ref: 0, role: 'button', name: 'Continue', editable: false, identity: '{"id":"continue"}' }],
    url: 'https://example.test/form', title: 'Fixture', probeError: undefined, clickError: undefined };
  const events = [];
  const tab = {
    async url() { assert.equal(this, tab); return state.url; },
    async title() { assert.equal(this, tab); return state.title; },
    async getAXState(options) { assert.equal(this, tab); assert.deepEqual(options, { emit: false, disableDiffing: true }); events.push(['native-observe']); return state.ax; },
    async click(ref) { assert.equal(this, tab); events.push(['native-click', ref]); if (state.clickError) throw state.clickError; },
    async typeText(ref, text) { assert.equal(this, tab); events.push(['native-type', ref, text]); state.ax = state.ax.replace('Value: old ', `Value: old${text}`); },
    async setValue(ref, value) { assert.equal(this, tab); events.push(['native-set', ref, value]); state.ax = state.ax.replace('Value: old ', `Value: ${value}`); },
    playwright: {
      async evaluate() { events.push(['dom-observe']); return structuredClone({ url: state.url, title: state.title, text: 'Ready', candidateCount: state.domElements.length,
        elements: state.domElements }); },
      locator() { return { nth(ref) { return {
        async getAttribute(name) { events.push(['probe', ref, name]); if (state.probeError) throw state.probeError; return 'continue'; },
        async click() { events.push(['dom-click', ref]); if (state.clickError) throw state.clickError; },
        async fill(value) { events.push(['dom-fill', ref, value]); state.domElements[ref].value = value; },
      }; } }; },
    },
  };
  return { tab, state, events };
}

test('explicit native-actions maps a stable DOM identity to the newest native AX ref', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  assert.equal(target.backend, 'native-actions');
  await target.getObservation();
  f.state.ax = '0 AXWebArea Fixture\nBanner changed\n137 button Continue';
  await target.click(0);
  assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['native-click', 137]]);
  assert.equal(f.events.filter(([name]) => name === 'native-observe').length, 1);
  assert.ok(!f.events.some(([name]) => name === 'probe'));
});

test('native-actions input uses one verified DOM fill and no native typing', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.domElements = [{ ref: 0, role: 'search field', name: 'Search', value: 'old ', editable: true, identity: '{"id":"search"}' }];
  const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  await target.getObservation(); await target.typeText(0, '여권');
  assert.deepEqual(f.events.filter(([name]) => name === 'dom-fill'), [['dom-fill', 0, 'old 여권']]);
  assert.ok(!f.events.some(([name]) => name.startsWith('native-')));
});

for (const side of ['DOM', 'native']) {
  test(`native-actions rejects ambiguous ${side} role and name mappings`, async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab();
    if (side === 'DOM') f.state.domElements.push({ ...f.state.domElements[0], ref: 1, identity: '{"id":"duplicate"}' });
    else f.state.ax += '\n9 button Continue';
    const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
    await target.getObservation();
    await assert.rejects(target.click(0), /STALE_OBSERVATION/);
    assert.ok(!f.events.some(([name]) => name.endsWith('click')));
  });
}

test('native-actions rejects changed DOM identity before taking any native action', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  await target.getObservation(); f.state.domElements[0].identity = '{"id":"replacement"}';
  await assert.rejects(target.click(0), /STALE_OBSERVATION/);
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

test('native-actions rejects different native page metadata', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.tab.url = async () => 'https://other.test/';
  const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  await target.getObservation();
  await assert.rejects(target.click(0), /STALE_OBSERVATION/);
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

test('native-actions rejects a different observed native link URL', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab();
  f.state.domElements[0] = { ref: 0, role: 'link', name: 'Continue', editable: false, identity: '{"href":"/one"}' };
  f.state.ax = '0 AXWebArea Fixture\n7 link Continue, URL: https://example.test/two';
  const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  await target.getObservation();
  await assert.rejects(target.click(0), /STALE_OBSERVATION/);
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

for (const [nativeDescription, accepted] of [['Delete saved draft', false], ['Continue', true], ['Open next article', true]]) {
  test(`native-actions cross-checks meaningful descriptions (${nativeDescription})`, async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab(); f.state.domElements[0].description = 'Open\nnext article';
    f.state.ax = `0 AXWebArea Fixture\n7 button Continue, Description: ${nativeDescription}`;
    const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
    await target.getObservation();
    if (accepted) {
      await target.click(0);
      assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['native-click', 7]]);
    } else {
      await assert.rejects(target.click(0), /STALE_OBSERVATION/);
      assert.ok(!f.events.some(([name]) => name.endsWith('click')));
    }
  });
}

test('native-actions click errors never invoke DOM click or repeat the action', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.clickError = new Error('CDP deadline after dispatch');
  const target = await createCodexTarget(f.tab, { backend: 'native-actions' });
  await target.getObservation();
  await assert.rejects(target.click(0), failure => failure.code === 'CDP_CONNECTION_FAILED' && failure.actionDispatched === true);
  assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['native-click', 7]]);
  await assert.rejects(target.click(0), /OBSERVATION_REQUIRED/);
});

test('auto selects healthy DOM with a read-only probe before any physical action', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab();
  const target = await createCodexTarget(f.tab);
  assert.equal(target.backend, 'dom');
  assert.deepEqual(f.events, [['dom-observe'], ['probe', 0, 'id']]);
  await target.getObservation(); await target.click(0);
  assert.ok(f.events.some(([name]) => name === 'dom-click'));
  assert.ok(!f.events.some(([name]) => name.startsWith('native-')));
});

test('only a known locator engine compatibility failure selects native AX refs', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.probeError = new Error('this._engines.set is not a function SECRET');
  const target = await createCodexTarget(f.tab);
  assert.equal(target.backend, 'native');
  assert.equal(target.backendReason, 'LOCATOR_ENGINE_FAILED');
  const observation = await target.getObservation();
  assert.equal(observation.elements[0].ref, 7);
  assert.equal(observation.url, f.state.url);
  await target.click(7);
  assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['native-click', 7]]);
});

for (const message of ['CDP deadline before dispatch SECRET', 'Timeout 5000ms SECRET', 'Unexpected SECRET']) {
  test('unknown/transport preflight errors do not silently switch drivers', async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab(); f.state.probeError = new Error(message);
    await assert.rejects(createCodexTarget(f.tab), error => !error.message.includes('SECRET'));
    assert.ok(!f.events.some(([name]) => name.startsWith('native-')));
  });
}

test('an action error never invokes the other driver or replays the click', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab);
  await target.getObservation();
  f.state.clickError = new Error('this._engines.set is not a function SECRET');
  await assert.rejects(target.click(0), error => error.code === 'LOCATOR_ENGINE_FAILED');
  assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['dom-click', 0]]);
});

test('explicit native skips DOM and rejects an unobserved DOM reference', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab, { backend: 'native' });
  await target.getObservation();
  await assert.rejects(target.click(0), /INVALID_TARGET/);
  assert.ok(!f.events.some(([name]) => name.startsWith('dom-') || name === 'probe' || name.endsWith('click')));
});

test('native refs require a fresh unchanged full snapshot and are consumed once', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab, { backend: 'native' });
  await target.getObservation(); f.state.url = 'https://other.test/';
  await assert.rejects(target.click(7), /STALE_OBSERVATION/);
  await assert.rejects(target.click(7), /OBSERVATION_REQUIRED/);
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

test('native link URL and ID preserve strong identity across unrelated banner and ref changes', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.url = 'https://www.hsmu.ac.kr/web/main/index.do';
  f.state.ax = '0 AXWebArea Fixture\n8 link Description: H, Value: hsmu.ac.kr/web/contents/HSMU10100000.do, ID: GNB_HSMU10000000';
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  const before = await target.getObservation();
  assert.equal(before.elements[0].value, 'hsmu.ac.kr/web/contents/HSMU10100000.do');
  assert.equal(JSON.parse(before.elements[0].identity).id, 'GNB_HSMU10000000');
  f.state.ax = '0 AXWebArea Fixture\nNew animated banner\n108 link Description: H, Value: hsmu.ac.kr/web/contents/HSMU10100000.do, ID: GNB_HSMU10000000';
  await target.click(8);
  assert.deepEqual(f.events.filter(([name]) => name.endsWith('click')), [['native-click', 108]]);
});

for (const change of ['href', 'duplicate']) {
  test(`native reliable link rejects changed ${change}`, async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab(); f.state.ax = '0 AXWebArea Fixture\n8 link Description: Continue, Value: https://example.test/one';
    const target = await createCodexTarget(f.tab, { backend: 'native' });
    await target.getObservation();
    f.state.ax = change === 'href' ? '0 AXWebArea Fixture\n9 link Description: Continue, Value: https://example.test/two'
      : '0 AXWebArea Fixture\n8 link Description: Continue, Value: https://example.test/one\n9 link Description: Continue, Value: https://example.test/one';
    await assert.rejects(target.click(8), /STALE_OBSERVATION/);
    assert.ok(!f.events.some(([name]) => name.endsWith('click')));
  });
}

test('native links without trustworthy navigation values retain full snapshot checks', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.ax = '0 AXWebArea Fixture\n8 link Menu, Value: javascript:openMenu()';
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  assert.equal((await target.getObservation()).elements[0].identity, undefined);
  f.state.ax += '\nChanged banner';
  await assert.rejects(target.click(8), /STALE_OBSERVATION/);
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

test('native protected controls are redacted and cannot be acted on', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.ax += '\n9 secure text field Password, Value: SECRET';
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  const observation = await target.getObservation();
  assert.equal(observation.elements.find(element => element.ref === 9).protected, true);
  assert.ok(!JSON.stringify(observation).includes('SECRET'));
  await assert.rejects(target.typeText(9, 'host text'), /INVALID_TARGET/);
});

for (const label of ['Card number', 'Security code', 'One time code', 'CVV', '카드번호', '일회용 인증번호']) {
  test(`native ${label} is redacted before provider observation`, async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab(); f.state.ax += `\n9 text field ${label}, Description: SECRET HELP, Value: SECRET VALUE`;
    const target = await createCodexTarget(f.tab, { backend: 'native' });
    const observation = await target.getObservation();
    assert.equal(observation.elements.find(element => element.ref === 9).protected, true);
    assert.ok(!JSON.stringify(observation).includes('SECRET'));
    await assert.rejects(target.typeText(9, 'host text'), /INVALID_TARGET/);
  });
}

for (const key of ['url', 'title']) {
  test(`native capture rejects ${key} that keeps changing while AX is read`, async () => {
    const { createCodexTarget } = await load();
    const f = fakeTab(); let calls = 0;
    f.tab[key] = async () => key === 'url' ? `https://example.test/page-${++calls}` : `Title ${++calls}`;
    const target = await createCodexTarget(f.tab, { backend: 'native' });
    await assert.rejects(target.getObservation(), /STALE_OBSERVATION/);
    await assert.rejects(target.click(7), /OBSERVATION_REQUIRED/);
    assert.ok(!f.events.some(([name]) => name.endsWith('click')));
  });
}

test('a navigation-raced native snapshot is discarded and one coherent recapture is returned', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); let captures = 0;
  const read = f.tab.getAXState.bind(f.tab);
  f.tab.getAXState = async options => {
    const snapshot = await read(options);
    if (++captures === 1) {
      f.state.url = 'https://example.test/destination';
      f.state.title = 'Destination';
      f.state.ax = '0 AXWebArea Destination\n4 button Destination action';
    }
    return snapshot;
  };
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  const observation = await target.getObservation();
  assert.equal(captures, 2);
  assert.equal(observation.url, 'https://example.test/destination');
  assert.equal(observation.title, 'Destination');
  assert.equal(observation.elements[0].name, 'Destination action');
  assert.ok(!observation.text.includes('Continue'));
  assert.ok(!f.events.some(([name]) => name.endsWith('click')));
});

test('native capture errors other than metadata drift are never retried', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); let captures = 0;
  f.tab.getAXState = async () => { captures++; throw new Error('CDP deadline before dispatch'); };
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  await assert.rejects(target.getObservation(), failure => failure.code === 'CDP_CONNECTION_FAILED');
  assert.equal(captures, 1);
});

test('preflight uses an observed unique semantic locator when available', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab();
  f.tab.playwright.getByRole = (role, options) => ({ async getAttribute(name) {
    f.events.push(['semantic-probe', role, options, name]);
    throw new Error('this._engines.set is not a function');
  } });
  const target = await createCodexTarget(f.tab);
  assert.equal(target.backend, 'native');
  assert.deepEqual(f.events.find(([name]) => name === 'semantic-probe'), ['semantic-probe', 'button', { name: 'Continue', exact: true }, 'id']);
});

test('preflight timeout is bounded and never switches to native on an unresolved read', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab();
  f.tab.playwright.getByRole = () => ({ getAttribute: () => new Promise(() => {}) });
  await assert.rejects(createCodexTarget(f.tab, { preflightTimeoutMs: 10 }), failure => failure.code === 'ACTION_TIMEOUT' && failure.actionDispatched === false);
  assert.ok(!f.events.some(([name]) => name.startsWith('native-')));
});

test('native typing sets the complete append value once and verifies it', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); const target = await createCodexTarget(f.tab, { backend: 'native' });
  await target.getObservation(); await target.typeText(8, '여권');
  assert.deepEqual(f.events.filter(([name]) => name === 'native-set'), [['native-set', 8, 'old 여권']]);
});

test('native readonly fields cannot be modified', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.ax = '0 AXWebArea Fixture\n8 text field (readonly) Reference, Value: fixed';
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  assert.equal((await target.getObservation()).elements[0].editable, false);
  await assert.rejects(target.typeText(8, 'new'), /INVALID_TARGET/);
});

test('native typing does not act when the AX value has ambiguous marker text', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab(); f.state.ax = '0 AXWebArea Fixture\n8 text field Query, Value: old, Description: ambiguous';
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  await target.getObservation();
  await assert.rejects(target.typeText(8, 'new'), /INVALID_TARGET/);
});

test('partial native input is reported without a second attempt', async () => {
  const { createCodexTarget } = await load();
  const f = fakeTab();
  f.tab.setValue = async () => { f.events.push(['partial-set']); f.state.ax = f.state.ax.replace('Value: old ', 'Value: 여'); };
  const target = await createCodexTarget(f.tab, { backend: 'native' });
  await target.getObservation();
  await assert.rejects(target.typeText(8, '여권'), error => error.code === 'INPUT_VALUE_MISMATCH');
  assert.equal(f.events.filter(([name]) => name === 'partial-set').length, 1);
});
