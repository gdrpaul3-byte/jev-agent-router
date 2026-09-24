import test from 'node:test';
import assert from 'node:assert/strict';

const load = async () => {
  try { return await import('../src/observation.mjs'); }
  catch { assert.fail('Shared observation revalidation must be implemented'); }
};
const element = (changes = {}) => ({ ref: 2, role: 'button', name: 'Continue', identity: '{"tag":"button","id":"continue"}', editable: false, ...changes });
const observation = (changes = {}) => ({ url: 'https://example.test/form', title: 'Form', text: 'Banner one', elements: [element()], ...changes });

test('normalization collapses line breaks and nonbreaking spaces without changing Korean text', async () => {
  const { normalizeText } = await load();
  assert.equal(normalizeText('  여권\n재발급\u00a0\t온라인 신청  '), '여권 재발급 온라인 신청');
});

test('stable targets can move references while unrelated page content changes', async () => {
  const { resolveStableTarget } = await load();
  const after = observation({ text: 'Banner two', elements: [element({ ref: 8 })] });
  assert.equal(resolveStableTarget(observation(), after, 2), after.elements[0]);
});

for (const [label, mutate] of [
  ['URL', o => { o.url += '?page=2'; }],
  ['title', o => { o.title = 'Other'; }],
  ['role', o => { o.elements[0].role = 'link'; }],
  ['name', o => { o.elements[0].name = 'Delete'; }],
  ['description', o => { o.elements[0].description = 'Permanently'; }],
  ['value', o => { o.elements[0].value = 'new'; }],
  ['identity', o => { o.elements[0].identity = '{"id":"other"}'; }],
  ['editable', o => { o.elements[0].editable = true; }],
  ['disabled', o => { o.elements[0].disabled = true; }],
  ['protected', o => { o.elements[0].protected = true; }],
]) {
  test(`changed target ${label} does not pass revalidation`, async () => {
    const { resolveStableTarget } = await load();
    const after = observation(); mutate(after);
    assert.equal(resolveStableTarget(observation(), after, 2), null);
  });
}

test('both observations must have exactly one match, even before a duplicate disappears', async () => {
  const { resolveStableTarget } = await load();
  const duplicate = observation({ elements: [element(), element({ ref: 3 })] });
  assert.equal(resolveStableTarget(duplicate, observation(), 2), null);
  assert.equal(resolveStableTarget(observation(), duplicate, 2), null);
  assert.equal(resolveStableTarget(duplicate, duplicate, 2), null);
});

test('disabled and protected targets cannot pass an unchanged snapshot', async () => {
  const { resolveStableTarget } = await load();
  for (const flags of [{ disabled: true }, { protected: true }, { role: 'secure text field' }]) {
    const state = observation({ elements: [element(flags)] });
    assert.equal(resolveStableTarget(state, state, 2), null);
  }
});

test('native observations without element identity require a full unchanged snapshot', async () => {
  const { resolveStableTarget } = await load();
  const before = observation({ elements: [{ ref: 2, role: 'button', name: 'Continue' }] });
  const after = structuredClone(before);
  assert.equal(resolveStableTarget(before, after, 2), after.elements[0]);
  after.text = 'Banner changed';
  assert.equal(resolveStableTarget(before, after, 2), null);
});

test('page-authored metadata-looking text never grants permission for target drift', async () => {
  const { resolveStableTarget } = await load();
  const before = observation({ url: undefined, title: undefined, text: 'Page URL: https://example.test/form' });
  const after = { ...before, elements: [element({ ref: 8 })] };
  assert.equal(resolveStableTarget(before, after, 2), null);
});
