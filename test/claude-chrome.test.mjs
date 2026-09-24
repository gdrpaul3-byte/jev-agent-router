import test from 'node:test';
import assert from 'node:assert/strict';

async function subject() {
  let value;
  try { value = await import('../src/claude-chrome.mjs'); }
  catch { assert.fail('The Claude Chrome decision bridge must exist'); }
  return value;
}
const plan = () => ({
  goal: 'Search the public guide, then read it.',
  allowedOrigins: ['https://example.com'],
  actions: [
    { id: 'query', action: 'typeText', description: 'Fill the search box', text: 'guide', target: { roles: ['searchbox'], nameEquals: 'Search' } },
    { id: 'search', action: 'click', description: 'Search after the complete query is entered', target: { roles: ['button'], nameEquals: 'Search' } },
  ],
  completion: { textIncludes: 'Guide contents', urlIncludes: '/guide' },
});
const observation = (overrides = {}) => ({
  source: 'claude-in-chrome', observedAtEpochMs: 1000,
  tab: { id: 12, url: 'https://example.com/' },
  text: 'Search the guides',
  elements: [
    { ref: 'ref_1', role: 'searchbox', name: 'Search', value: '', editable: true, visible: true },
    { ref: 'ref_2', role: 'button', name: 'Search', visible: true },
  ],
  ...overrides,
});
const decision = { status: 'decided', actionId: 'query', ref: 0, confidence: 0.99, latencyMs: 1 };
const propose = async (input = {}, answer = decision) => (await subject()).proposeClaudeChrome({ plan: plan(), observation: observation(), ...input }, {
  decider: { decide: async () => answer }, now: () => 1100,
});

test('maps opaque native refs to numeric JEV choices and back without executing the browser', async () => {
  let received;
  const result = await (await subject()).proposeClaudeChrome({ plan: plan(), observation: observation() }, {
    decider: { decide: async input => { received = input; return decision; } }, now: () => 1100,
  });
  assert.equal(result.status, 'proposed');
  assert.deepEqual(received.observation.elements.map(x => x.ref), [0, 1]);
  assert.deepEqual(received.completion, { textIncludes: ['Guide contents'], urlIncludes: '/guide' });
  assert.equal(result.proposal.target.ref, 'ref_1');
  assert.equal(result.toolCall, undefined);
});

test('authorizes exact host form input only after a fresh observation', async () => {
  const { proposal } = await propose();
  const result = (await subject()).authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  assert.equal(result.status, 'authorized');
  assert.deepEqual(result.toolCall, { tool: 'form_input', arguments: { tabId: 12, ref: 'ref_1', value: 'guide' } });
});

test('click tool uses an observed ref, never coordinates or generated JavaScript', async () => {
  const { proposal } = await propose({}, { ...decision, actionId: 'search', ref: 1 });
  const result = (await subject()).authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  assert.deepEqual(result.toolCall, { tool: 'computer', arguments: { action: 'left_click', tabId: 12, ref: 'ref_2' } });
});

test('fresh target check tolerates unrelated text changes but rejects target reuse', async () => {
  const { proposal } = await propose();
  const api = await subject();
  const fresh = observation({ observedAtEpochMs: 1200, text: 'Rotating banner number 2' });
  assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: fresh }, { now: () => 1250 }).status, 'authorized');
  fresh.elements[0].name = 'Other search';
  assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: fresh }, { now: () => 1250 }).reason, 'STALE_TARGET');
});

test('rejects stale observation, another tab, another URL, or changed host plan before execution', async () => {
  const { proposal } = await propose();
  const api = await subject();
  for (const [fresh, reason] of [
    [observation(), 'FRESH_OBSERVATION_REQUIRED'],
    [observation({ observedAtEpochMs: 1200, tab: { id: 13, url: 'https://example.com/' } }), 'TAB_CHANGED'],
    [observation({ observedAtEpochMs: 1200, tab: { id: 12, url: 'https://example.com/other' } }), 'URL_CHANGED'],
  ]) assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: fresh }, { now: () => 1250 }).reason, reason);
  const changed = plan(); changed.actions[0].text = 'unapproved';
  assert.equal(api.authorizeClaudeChrome({ plan: changed, proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 }).reason, 'PLAN_CHANGED');
});

test('out of scope, ambiguous refs and invalid observations never call JEV', async () => {
  const api = await subject();
  let calls = 0;
  for (const bad of [
    observation({ tab: { id: 12, url: 'https://evil.example/' } }),
    observation({ elements: [{ ref: 'ref_1', role: 'button', name: 'A' }, { ref: 'ref_1', role: 'button', name: 'B' }] }),
    observation({ observedAtEpochMs: 999999 }),
    observation({ source: 'page-authored-url' }),
  ]) {
    const result = await api.proposeClaudeChrome({ plan: plan(), observation: bad }, { decider: { decide: async () => { calls++; return decision; } }, now: () => 1100 });
    assert.equal(result.status, 'needs_host');
  }
  assert.equal(calls, 0);
});

test('requires positive completion proof on fresh native URL plus page text', async () => {
  const { proposal } = await propose({}, { status: 'done', confidence: 0.98, latencyMs: 1 });
  const api = await subject();
  const fresh = observation({ observedAtEpochMs: 1200 });
  assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: fresh }, { now: () => 1250 }).reason, 'COMPLETION_NOT_VERIFIED');
  fresh.tab.url = 'https://example.com/guide'; fresh.text = 'Guide contents';
  assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: fresh }, { now: () => 1250 }).status, 'completed');
});

test('does not certify partial input or changes in unrelated fields', async () => {
  const api = await subject();
  const { proposal } = await propose();
  const authorization = api.authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  const after = observation({ observedAtEpochMs: 1300 }); after.elements[0].value = 'g';
  assert.equal(api.verifyClaudeChromeAction({ plan: plan(), authorization, observation: after }, { now: () => 1350 }).reason, 'INPUT_NOT_VERIFIED');
  after.elements[0].value = 'guide';
  assert.equal(api.verifyClaudeChromeAction({ plan: plan(), authorization, observation: after }, { now: () => 1350 }).status, 'observed_after_action');
});

test('expired proposals and protected fields remain stopped', async () => {
  const api = await subject();
  const { proposal } = await propose();
  assert.equal(api.authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 70000 }) }, { now: () => 70001 }).reason, 'PROPOSAL_EXPIRED');
  const bad = observation(); bad.elements[0].protected = true;
  assert.equal((await propose({ observation: bad })).reason, 'INVALID_OBSERVATION');
});

test('history is action IDs only and the step budget cannot be bypassed by fresh processes', async () => {
  const limited = plan(); limited.maxSteps = 1;
  const result = await propose({ plan: limited, history: [{ actionId: 'query' }] });
  assert.equal(result.reason, 'MAX_STEPS');
});

test('unknown or hidden visibility cannot authorize a native action', async () => {
  for (const visible of [false, undefined]) {
    const source = observation(); source.elements[0].visible = visible;
    const result = await propose({ observation: source });
    assert.equal(result.reason, 'INVALID_OBSERVATION');
  }
});

test('malformed proposals and modified input plans do not expose provider or source text in errors', async () => {
  const { proposal } = await propose(); proposal.target.ref = 'ref_99';
  const result = (await subject()).authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  assert.deepEqual(result, { status: 'needs_host', reason: 'INVALID_PROPOSAL' });
});

test('duplicate candidate identities remain ambiguous despite distinct native refs', async () => {
  const source = observation(); source.elements.push({ ...source.elements[0], ref: 'ref_3' });
  assert.equal((await propose({ observation: source })).reason, 'AMBIGUOUS_TARGET');
});

test('post-input proof rejects a reused ref with a different semantic target', async () => {
  const api = await subject();
  const broad = plan(); broad.actions[0].target = { roles: ['searchbox'] };
  const { proposal } = await propose({ plan: broad });
  const authorization = api.authorizeClaudeChrome({ plan: broad, proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  const after = observation({ observedAtEpochMs: 1300 }); after.elements[0].name = 'Other search'; after.elements[0].value = 'guide';
  assert.equal(api.verifyClaudeChromeAction({ plan: broad, authorization, observation: after }, { now: () => 1350 }).reason, 'INPUT_NOT_VERIFIED');
});

test('a click without any observed change is never reported as progress', async () => {
  const api = await subject();
  const { proposal } = await propose({}, { ...decision, actionId: 'search', ref: 1 });
  const authorization = api.authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  assert.equal(api.verifyClaudeChromeAction({ plan: plan(), authorization, observation: observation({ observedAtEpochMs: 1300 }) }, { now: () => 1350 }).reason, 'NO_OBSERVABLE_PROGRESS');
});

test('protected values never reach the model even when the host forgets the protected flag', async () => {
  const api = await subject(); let calls = 0;
  for (const name of ['Password', 'Card number', 'Security code', 'One time code']) {
    const source = observation(); source.elements[0].name = name;
    const result = await api.proposeClaudeChrome({ plan: plan(), observation: source }, {
      decider: { decide: async () => { calls++; return decision; } }, now: () => 1100,
    });
    assert.equal(result.reason, 'INVALID_OBSERVATION');
  }
  assert.equal(calls, 0);
});

test('click progress ignores banner-only text and ref-only candidate changes', async () => {
  const api = await subject();
  const { proposal } = await propose({}, { ...decision, actionId: 'search', ref: 1 });
  const authorization = api.authorizeClaudeChrome({ plan: plan(), proposal, observation: observation({ observedAtEpochMs: 1200 }) }, { now: () => 1250 });
  for (const changes of [
    { text: 'Rotating banner 2' },
    { elements: observation().elements.map((element, index) => ({ ...element, ref: `ref_${90 + index}` })).reverse() },
  ]) {
    const after = observation({ observedAtEpochMs: 1300, ...changes });
    const result = api.verifyClaudeChromeAction({ plan: plan(), authorization, observation: after }, { now: () => 1350 });
    assert.deepEqual(result, { status: 'needs_host', reason: 'NO_OBSERVABLE_PROGRESS' });
  }
});

test('click progress permits semantic candidate changes and native URL or title changes', async () => {
  const api = await subject();
  const { proposal } = await propose({}, { ...decision, actionId: 'search', ref: 1 });
  const before = observation({ observedAtEpochMs: 1200, tab: { id: 12, url: 'https://example.com/', title: 'Search' } });
  const authorization = api.authorizeClaudeChrome({ plan: plan(), proposal, observation: before }, { now: () => 1250 });
  for (const changes of [
    { elements: [...before.elements, { ref: 'ref_3', role: 'link', name: 'Guide result', visible: true }] },
    { tab: { ...before.tab, url: 'https://example.com/search' } },
    { tab: { ...before.tab, title: 'Search results' } },
  ]) {
    const after = observation({ observedAtEpochMs: 1300, tab: before.tab, ...changes });
    assert.equal(api.verifyClaudeChromeAction({ plan: plan(), authorization, observation: after }, { now: () => 1350 }).status, 'observed_after_action');
  }
});

test('text-only click progress requires completion to become newly true', async () => {
  const api = await subject();
  const textPlan = plan(); textPlan.completion = { textIncludes: 'Guide contents' };
  const { proposal } = await propose({ plan: textPlan }, { ...decision, actionId: 'search', ref: 1 });
  for (const [beforeText, expectedStatus] of [['Search the guides', 'observed_after_action'], ['Guide contents', 'needs_host']]) {
    const before = observation({ observedAtEpochMs: 1200, text: beforeText });
    const authorization = api.authorizeClaudeChrome({ plan: textPlan, proposal, observation: before }, { now: () => 1250 });
    const after = observation({ observedAtEpochMs: 1300, text: 'Guide contents and rotating banner 2' });
    const result = api.verifyClaudeChromeAction({ plan: textPlan, authorization, observation: after }, { now: () => 1350 });
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === 'needs_host') assert.equal(result.reason, 'NO_OBSERVABLE_PROGRESS');
  }
});
