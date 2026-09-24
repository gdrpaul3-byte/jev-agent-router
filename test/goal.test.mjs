import test from 'node:test';
import assert from 'node:assert/strict';
import { runGoalWorkflow, prepareGoalPlan } from '../src/goal.mjs';

const actions = [{ id: 'open', action: 'click', description: 'Open the next permitted page', target: { roles: ['button'] } }];
const completion = { textIncludes: 'Verified article body', urlIncludes: '/article' };
function fixture({ mutateOnRead, delayAction = 0 } = {}) {
  let page = 0, reads = 0, clicks = 0;
  const target = {
    async getAXState() {
      reads++;
      const extra = mutateOnRead?.(reads) ?? '';
      return `0 AXWebArea Test\n1 text ${page >= 2 ? 'Verified article body' : `Stage ${page}`}\n2 button ${extra || 'Continue'}`;
    },
    async url() { return `https://example.test/${page >= 2 ? 'article' : 'start'}`; },
    async click(ref) { assert.equal(ref, 2); clicks++; await new Promise(r => setTimeout(r, delayAction)); page++; },
  };
  const decider = { async decide() { return page >= 2 ? { status: 'done', confidence: 1 } : { status: 'decided', actionId: 'open', ref: 2, confidence: 1 }; } };
  return { target, decider, get reads() { return reads; }, get clicks() { return clicks; } };
}
const options = f => ({ target: f.target, decider: f.decider, goal: 'Open the verified article', actions, completion, maxSteps: 4, maxDurationMs: 1000 });

test('continues multiple actions in one invocation and verifies DONE with fresh state', async () => {
  const f = fixture();
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 2);
  assert.equal(f.clicks, 2);
  assert.equal(f.reads, 6); // initial + two fresh guards + two post-action reads + final check
  assert.equal(result.metrics.decisions, 3);
  assert.equal(result.metrics.observations, 6);
});
test('false DONE cannot report completion', async () => {
  const f = fixture(); f.decider.decide = async () => ({ status: 'done', confidence: 1 });
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.reason, 'COMPLETION_NOT_VERIFIED'); assert.equal(f.clicks, 0);
});
test('requires trusted URL evidence rather than text that resembles a URL', async () => {
  const f = fixture(); f.target.getAXState = async () => '0 AXWebArea Test\n1 text Verified article body https://example.test/article';
  f.decider.decide = async () => ({ status: 'done', confidence: 1 });
  assert.equal((await runGoalWorkflow(options(f))).reason, 'COMPLETION_NOT_VERIFIED');
});
test('rejects a changed pre-action target without dispatch', async () => {
  const f = fixture({ mutateOnRead: n => n === 2 ? 'Delete everything' : '' });
  assert.equal((await runGoalWorkflow(options(f))).reason, 'STALE_OBSERVATION'); assert.equal(f.clicks, 0);
});

test('preserves the native title and rejects a title-only pre-action change', async () => {
  let reads = 0, clicks = 0, observedTitle;
  const target = {
    async getObservation() {
      return { text: 'Identical page text', url: 'https://example.test/start',
        title: ++reads === 1 ? 'Original page' : 'Changed page',
        elements: [{ ref: 2, role: 'button', name: 'Continue' }] };
    },
    async click() { clicks++; },
  };
  const decider = { async decide(input) {
    observedTitle = input.observation.title;
    return { status: 'decided', actionId: 'open', ref: 2, confidence: 1 };
  } };
  const result = await runGoalWorkflow({ ...options({ target, decider }), verificationTimeoutMs: 0 });
  assert.equal(result.reason, 'STALE_OBSERVATION');
  assert.equal(clicks, 0);
  assert.equal(observedTitle, 'Original page');
});

test('rejects a non-string native observation title before asking the decider', async () => {
  const target = {
    async getObservation() {
      return { text: 'page', url: 'https://example.test/start', title: 42,
        elements: [{ ref: 2, role: 'button', name: 'Continue' }] };
    },
    async click() { assert.fail('invalid observation must not act'); },
  };
  const decider = { async decide() { assert.fail('invalid observation must not reach decider'); } };
  assert.equal((await runGoalWorkflow(options({ target, decider }))).reason, 'OBSERVATION_FAILED');
});
test('rejects fabricated action or reference', async () => {
  for (const change of [{ actionId: 'delete' }, { ref: 999 }]) {
    const f = fixture(); f.decider.decide = async () => ({ status: 'decided', actionId: 'open', ref: 2, confidence: 1, ...change });
    assert.equal((await runGoalWorkflow(options(f))).reason, 'INVALID_DECISION'); assert.equal(f.clicks, 0);
  }
});
test('does not replay an action with unknown outcome', async () => {
  const f = fixture(); let called = 0; f.target.click = async () => { called++; throw new Error('private provider text'); };
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.reason, 'ACTION_FAILED'); assert.equal(called, 1);
  assert.equal(result.steps[0].status, 'action_outcome_unknown');
  assert.ok(!JSON.stringify(result).includes('private provider'));
});
test('late decisions cannot dispatch an action after deadline', async () => {
  const f = fixture(); f.decider.decide = async () => { await new Promise(r => setTimeout(r, 40)); return { status: 'decided', actionId: 'open', ref: 2, confidence: 1 }; };
  const result = await runGoalWorkflow({ ...options(f), maxDurationMs: 10 });
  assert.equal(result.reason, 'TIMEOUT');
  await new Promise(r => setTimeout(r, 50)); assert.equal(f.clicks, 0);
});
test('waits for an in-flight physical action to settle before releasing the target', async () => {
  const f = fixture({ delayAction: 40 });
  const running = runGoalWorkflow({ ...options(f), maxDurationMs: 15 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await runGoalWorkflow(options(f))).reason, 'TARGET_BUSY');
  const result = await running;
  assert.equal(result.reason, 'TIMEOUT_AFTER_ACTION'); assert.equal(f.clicks, 1);
  assert.equal(result.steps[0].status, 'action_performed_unverified');
});
test('honors abort before any observation or action', async () => {
  const f = fixture(), control = new AbortController(); control.abort();
  assert.equal((await runGoalWorkflow({ ...options(f), signal: control.signal })).reason, 'ABORTED');
  assert.equal(f.reads, 0); assert.equal(f.clicks, 0);
});
test('maxSteps is an action limit and still permits final DONE verification', async () => {
  const f = fixture(); assert.equal((await runGoalWorkflow({ ...options(f), maxSteps: 2 })).status, 'completed');
  const g = fixture(); assert.equal((await runGoalWorkflow({ ...options(g), maxSteps: 1 })).reason, 'MAX_STEPS'); assert.equal(g.clicks, 1);
});
test('requires nonempty positive completion evidence', () => {
  assert.equal(prepareGoalPlan({ goal: 'test', actions, completion: { textExcludes: 'error' } }), null);
  assert.equal(prepareGoalPlan({ goal: 'test', actions, completion: { textIncludes: '' } }), null);
});
test('explicit readonly metadata prevents typing', async () => {
  const target = { async getObservation() { return { text: 'page', url: 'https://example.test', elements: [{ ref: 2, role: 'text field', name: 'Search', editable: false }] }; }, async typeText() { assert.fail('must not type'); } };
  const decider = { async decide() { return { status: 'decided', actionId: 'type', ref: 2, confidence: 1 }; } };
  const result = await runGoalWorkflow({ target, decider, goal: 'Search', actions: [{ id: 'type', action: 'typeText', description: 'Search', text: 'q' }], completion: { textIncludes: 'result' } });
  assert.equal(result.reason, 'INVALID_DECISION');
});
test('structured protected metadata prevents typing even with a generic field name', async () => {
  let typed = false;
  const target = { async getObservation() { return { text: typed ? 'result' : 'page', url: 'https://example.test', elements: [{ ref: 2, role: 'text field', name: 'Login', editable: true, protected: true }] }; }, async typeText() { typed = true; } };
  const decider = { async decide() { return typed ? { status: 'done', confidence: 1 } : { status: 'decided', actionId: 'type', ref: 2, confidence: 1 }; } };
  const result = await runGoalWorkflow({ target, decider, goal: 'Search', actions: [{ id: 'type', action: 'typeText', description: 'Search', text: 'q' }], completion: { textIncludes: 'result' } });
  assert.equal(result.reason, 'INVALID_DECISION'); assert.equal(typed, false);
});
test('stops when navigation leaves the authorized origin', async () => {
  const f = fixture(); let next = false; f.target.url = async () => next ? 'https://outside.test' : 'https://example.test';
  f.target.click = async () => { next = true; };
  assert.equal((await runGoalWorkflow(options(f))).reason, 'OUT_OF_SCOPE');
});
test('post-action observations respect the shorter verification deadline', async () => {
  const f = fixture(); let reads = 0;
  const original = f.target.getAXState;
  f.target.getAXState = async () => { if (++reads === 3) await new Promise(r => setTimeout(r, 80)); return original(); };
  const result = await runGoalWorkflow({ ...options(f), verificationTimeoutMs: 10 });
  assert.equal(result.reason, 'NO_OBSERVABLE_PROGRESS'); assert.equal(f.clicks, 1);
});
test('an event-loop-blocking final read cannot report success past the global deadline', async () => {
  const f = fixture(); let reads = 0;
  f.target.getAXState = async () => {
    if (++reads === 2) { const until = performance.now() + 40; while (performance.now() < until) {} }
    return '0 AXWebArea Test\n1 text Verified article body';
  };
  f.target.url = async () => 'https://example.test/article';
  f.decider.decide = async () => ({ status: 'done', confidence: 1 });
  assert.equal((await runGoalWorkflow({ ...options(f), maxDurationMs: 20 })).reason, 'TIMEOUT');
});
test('a timed-out observation retains the target lease until the read settles', async () => {
  const f = fixture(); let reads = 0;
  const original = f.target.getAXState;
  f.target.getAXState = async () => { if (++reads === 3) await new Promise(r => setTimeout(r, 80)); return original(); };
  const result = await runGoalWorkflow({ ...options(f), verificationTimeoutMs: 10 });
  assert.equal(result.reason, 'NO_OBSERVABLE_PROGRESS');
  assert.equal((await runGoalWorkflow(options(f))).reason, 'TARGET_BUSY');
  await new Promise(r => setTimeout(r, 100));
  assert.notEqual((await runGoalWorkflow(options(f))).reason, 'TARGET_BUSY');
});

function identifiedFixture({ changeTarget, changeBody = true, finishOnClick = true, shiftRef = true } = {}) {
  let reads = 0, clicked = false;
  const clickedRefs = [];
  const target = {
    async getObservation() {
      reads++;
      const complete = clicked && finishOnClick;
      return { text: complete ? 'Verified article body' : `Ready ${changeBody ? reads : ''}`,
        url: `https://example.test/${complete ? 'article' : 'start'}`, title: 'Page',
        elements: [{ ref: reads > 1 && shiftRef ? 9 : 2, role: 'button', name: 'Continue',
          identity: 'stable-button-id', ...(reads > 1 ? changeTarget : {}) }] };
    },
    async click(ref) { clickedRefs.push(ref); clicked = true; },
  };
  const decider = { async decide() { return clicked ? { status: 'done', confidence: 1 }
    : { status: 'decided', actionId: 'open', ref: 2, confidence: 1 }; } };
  return { target, decider, clickedRefs };
}

test('stable identified targets survive banner changes and dispatch the fresh ref', async () => {
  const f = identifiedFixture();
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.clickedRefs, [9]);
  assert.equal(result.steps[0].ref, 9);
});

for (const changeTarget of [{ identity: 'replaced-button' }, { name: 'Delete' }, { value: 'changed' }, { disabled: true }, { protected: true }]) {
  test(`identified target ${Object.keys(changeTarget)[0]} changes still stop before dispatch`, async () => {
    const f = identifiedFixture({ changeTarget });
    assert.equal((await runGoalWorkflow(options(f))).reason, 'STALE_OBSERVATION');
    assert.deepEqual(f.clickedRefs, []);
  });
}

test('banner-only changes cannot count as progress after an identified target click', async () => {
  const f = identifiedFixture({ finishOnClick: false });
  const result = await runGoalWorkflow({ ...options(f), verificationTimeoutMs: 10 });
  assert.equal(result.reason, 'NO_OBSERVABLE_PROGRESS');
  assert.equal(result.metrics.decisions, 1);
  assert.deepEqual(f.clickedRefs, [9]);
});

test('completion text-only updates still require the separate fresh DONE verification', async () => {
  const f = identifiedFixture();
  const read = f.target.getObservation;
  f.target.getObservation = async () => ({ ...await read(), url: 'https://example.test/start' });
  const result = await runGoalWorkflow({ ...options(f), completion: { textIncludes: 'Verified article body' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.decisions, 2);
  assert.equal(result.metrics.observations, 4);
});

test('already-present completion text does not disguise an ineffective repeated action', async () => {
  const f = identifiedFixture({ finishOnClick: false });
  const result = await runGoalWorkflow({ ...options(f), completion: { textIncludes: 'Ready' }, verificationTimeoutMs: 10 });
  assert.equal(result.reason, 'NO_OBSERVABLE_PROGRESS');
  assert.equal(result.metrics.decisions, 1);
  assert.deepEqual(f.clickedRefs, [9]);
});

for (const dispatched of [false, true]) {
  test(`adapter failure preserves safe diagnostics and ${dispatched ? 'unknown' : 'not dispatched'} outcome`, async () => {
    const f = fixture(); let attempts = 0;
    f.target.click = async () => { attempts++; throw Object.assign(new Error('private input'), {
      code: 'LOCATOR_ENGINE_FAILED', detail: 'CDP_CONNECTION_FAILED', actionDispatched: dispatched,
    }); };
    const result = await runGoalWorkflow(options(f));
    assert.equal(result.reason, 'ACTION_FAILED');
    assert.equal(result.detail, 'CDP_CONNECTION_FAILED');
    assert.equal(result.steps[0].errorCode, 'LOCATOR_ENGINE_FAILED');
    assert.equal(result.steps[0].status, dispatched ? 'action_outcome_unknown' : 'action_not_dispatched');
    assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(result), /private input/);
  });
}

test('observation failure preserves only known safe error detail', async () => {
  const f = fixture();
  f.target.getAXState = async () => { throw Object.assign(new Error('sensitive page'), { code: 'CDP_CONNECTION_FAILED' }); };
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.reason, 'OBSERVATION_FAILED');
  assert.equal(result.detail, 'CDP_CONNECTION_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test('goal results expose safe decision diagnostics without arbitrary provider data', async () => {
  const f = fixture();
  f.decider.decide = async () => ({ status: 'needs_host', reason: 'LOW_CONFIDENCE', detail: 'OPERATION',
    diagnostics: { head: 'OPERATION', choice: 'open', confidence: 0.6, margin: 0.2, raw: 'private page' } });
  const result = await runGoalWorkflow(options(f));
  assert.equal(result.reason, 'LOW_CONFIDENCE');
  assert.deepEqual(result.diagnostics, { head: 'OPERATION', choice: 'open', confidence: 0.6, margin: 0.2 });
  assert.equal(f.clicks, 0);
  assert.doesNotMatch(JSON.stringify(result), /private page/);
});

test('runner sends the validated completion contract to the decider', async () => {
  const f = fixture(); let contract;
  f.decider.decide = async input => { contract = input.completion; return { status: 'done', confidence: 1 }; };
  const result = await runGoalWorkflow(options(f));
  assert.deepEqual(contract, { textIncludes: ['Verified article body'], urlIncludes: '/article' });
  assert.ok(Object.isFrozen(contract));
  assert.equal(result.reason, 'COMPLETION_NOT_VERIFIED');
  assert.equal(f.clicks, 0);
});
