import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAX, runCuaWorkflow } from '../src/cua.mjs';
import * as cua from '../src/cua.mjs';

const start = '0 AXWebArea Draft\n\t1 text field (settable, string) Description: Search, Value: \n\t2 button Continue';
const typed = '0 AXWebArea Draft\n\t1 text field (settable, string) Description: Search, Value: otters\n\t2 button Continue';
const done = '0 AXWebArea Results\n\t1 static text Three matching otters\n\t2 link Description: Back, Value: example.com/';
const clickStep = { instruction: 'Continue to results', action: 'click', expect: { textIncludes: 'AXWebArea Results' } };

function fixture(snapshots = [start, start, done], selections = [{ status: 'selected', ref: 2, confidence: 0.99, latencyMs: 7 }]) {
  const events = [];
  let snapshotIndex = 0;
  let selectionIndex = 0;
  const target = {
    async getAXState(options) {
      assert.deepEqual(options, { emit: false, disableDiffing: true });
      events.push(['observe']);
      return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
    },
    async click(ref) { events.push(['click', ref]); },
    async typeText(ref, text) { events.push(['typeText', ref, text]); },
    async pressKey(ref, key) { events.push(['pressKey', ref, key]); },
    async scroll(ref, direction, distance) { events.push(['scroll', ref, direction, distance]); },
  };
  const selector = { async select(request) {
    events.push(['select', request]);
    return selections[Math.min(selectionIndex++, selections.length - 1)];
  } };
  return { target, selector, events, goal: 'Find otters', steps: [clickStep] };
}

const actions = f => f.events.filter(([name]) => ['click', 'typeText', 'pressKey', 'scroll'].includes(name));

test('opt-in observation reuse saves a read while retaining the fresh pre-action guard', async () => {
  let page = 0, reads = 0;
  const frames = ['0 AXWebArea Start\n1 button Continue', '0 AXWebArea Middle\n1 button Continue', '0 AXWebArea Finish\n1 text Verified'];
  const result = await runCuaWorkflow({
    target: { async getAXState() { reads++; return frames[page]; }, async click() { page++; } },
    selector: { async select() { return { status: 'selected', ref: 1, confidence: 1 }; } },
    goal: 'Finish', reuseVerifiedObservation: true,
    steps: [
      { instruction: 'Continue', action: 'click', expect: { textIncludes: 'Middle' } },
      { instruction: 'Continue', action: 'click', expect: { textIncludes: 'Finish' } },
    ],
  });
  assert.equal(result.status, 'completed'); assert.equal(reads, 5);
});

test('a timed-out fixed-plan read keeps the shared lease until its late result settles', async () => {
  const { runGoalWorkflow } = await import('../src/goal.mjs');
  const f = fixture();
  let release;
  const original = f.target.getAXState;
  let reads = 0;
  f.target.getAXState = async options => {
    if (++reads === 1) await new Promise(resolve => { release = resolve; });
    return original(options);
  };
  const result = await runCuaWorkflow({ ...f, maxDurationMs: 10 });
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal((await runCuaWorkflow(f)).reason, 'TARGET_BUSY');
  assert.equal((await runGoalWorkflow({ target: f.target, goal: 'Finish',
    actions: [{ id: 'go', action: 'click', description: 'Continue' }], completion: { textIncludes: 'Finished' },
    decider: { async decide() { assert.fail('must not decide while a previous read is pending'); } },
  })).reason, 'TARGET_BUSY');
  assert.equal(reads, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual((await runCuaWorkflow(f)).reason, 'TARGET_BUSY');
});

test('structured target identity changes invalidate a selection with identical AX text', async () => {
  let identity = 'original-destination', clicks = 0;
  const target = {
    async getAXState() { return '0 AXWebArea Page\n1 link Continue'; },
    async getObservation() { return { text: 'Ready', axText: '0 AXWebArea Page\n1 link Continue',
      url: 'https://example.test', title: 'Page', elements: [{ ref: 1, role: 'link', name: 'Continue', editable: false, identity }] }; },
    async click() { clicks++; },
  };
  const result = await runCuaWorkflow({ target, goal: 'Continue', steps: [clickStep],
    selector: { async select() { identity = 'different-destination'; return { status: 'selected', ref: 1, confidence: 1 }; } },
  });
  assert.equal(result.reason, 'STALE_OBSERVATION');
  assert.equal(clicks, 0);
});

for (const field of ['url', 'title']) {
  test(`structured native ${field} changes invalidate a selection with identical page text`, async () => {
    let changed = false, clicks = 0;
    const target = {
      async getAXState() { return '0 AXWebArea Page\n1 button Continue'; },
      async getObservation() { return { text: 'Ready', url: 'https://example.test', title: 'Page',
        ...(changed ? { [field]: field === 'url' ? 'https://example.test/changed' : 'Changed' } : {}),
        elements: [{ ref: 1, role: 'button', name: 'Continue' }] }; },
      async click() { clicks++; },
    };
    const result = await runCuaWorkflow({ target, goal: 'Continue', steps: [clickStep],
      selector: { async select() { changed = true; return { status: 'selected', ref: 1, confidence: 1 }; } },
    });
    assert.equal(result.reason, 'STALE_OBSERVATION'); assert.equal(clicks, 0);
  });
}

for (const flags of [{ editable: false }, { protected: true }]) {
  test(`fixed plans reject structured ${Object.keys(flags)[0]} field metadata`, async () => {
    let typed = false;
    const target = {
      async getAXState() { return '0 AXWebArea Page\n1 text field Login'; },
      async getObservation() { return { text: 'Ready', url: 'https://example.test', elements: [{ ref: 1, role: 'text field', name: 'Login', ...flags }] }; },
      async typeText() { typed = true; },
    };
    const result = await runCuaWorkflow({ target, goal: 'Type',
      steps: [{ instruction: 'Type supplied text', action: 'typeText', text: 'host input', expect: { textIncludes: 'Done' } }],
      selector: { async select() { return { status: 'selected', ref: 1, confidence: 1 }; } },
    });
    assert.equal(result.reason, 'INVALID_TARGET'); assert.equal(typed, false);
  });
}

test('a blocking verification read cannot pass the local verification deadline', async () => {
  const f = fixture();
  let reads = 0;
  const original = f.target.getAXState;
  f.target.getAXState = async options => {
    if (++reads === 3) { const until = performance.now() + 40; while (performance.now() < until) {} }
    return original(options);
  };
  const result = await runCuaWorkflow({ ...f, verificationTimeoutMs: 10 });
  assert.equal(result.reason, 'VERIFICATION_FAILED');
  assert.equal(actions(f).length, 1);
});

test('parseAX extracts actual CUA roles and labels while preserving full verification text', () => {
  const text = 'Browser tab: Example\n0 AXWebArea Title, URL: https://example.com/\n\t1 link Description: Home page, Value: example.com/\n\t2 button Continue\n\t3 text field (settable, string) Description: Search, Value: abc\n\t4 pop up button (collapsed) Description: Settings, ID: radix-1, Secondary Actions: Expand\n\t5 static text Nothing selected\n\t6 check box (disabled) Description: Accept\n\t7 search field Description: Filter, Value: \n\t8 radio button Personal\n\t9 combo box Description: Country\n\t10 slider Description: Volume, Value: 50';
  const parsed = parseAX(text);
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.elements, [
    { ref: 1, role: 'link', name: 'Home page', description: 'Home page', value: 'example.com/' },
    { ref: 2, role: 'button', name: 'Continue' },
    { ref: 3, role: 'text field', name: 'Search', description: 'Search', value: 'abc' },
    { ref: 4, role: 'pop up button', name: 'Settings', description: 'Settings' },
    { ref: 6, role: 'check box', name: 'Accept', description: 'Accept', disabled: true },
    { ref: 7, role: 'search field', name: 'Filter', description: 'Filter', value: '' },
    { ref: 8, role: 'radio button', name: 'Personal' },
    { ref: 9, role: 'combo box', name: 'Country', description: 'Country' },
    { ref: 10, role: 'slider', name: 'Volume', description: 'Volume', value: '50' },
  ]);
});

test('parseAX rejects duplicate refs even when one line is noninteractive', () => {
  assert.throws(() => parseAX('0 AXWebArea Home\n1 static text Status\n1 button Continue'), /duplicate/i);
});

test('parseAX rejects malformed refs and invalid inputs', () => {
  for (const text of ['0 AXWebArea Home\n-1 button Continue', '0 AXWebArea Home\nx button Continue', '0 AXWebArea Home\n1.5 button Continue', '9007199254740992 button Continue']) {
    assert.throws(() => parseAX(text), /malformed|invalid/i);
  }
  assert.throws(() => parseAX({ text: start }), /string/i);
  assert.throws(() => parseAX(''), /empty|invalid/i);
});

test('runs and independently verifies a two-step host-authored workflow', async () => {
  const f = fixture([start, start, typed, typed, typed, done], [
    { status: 'selected', ref: 1, confidence: 0.98, latencyMs: 5, action: 'click', text: 'attacker text' },
    { status: 'selected', ref: 2, confidence: 0.99, latencyMs: 7 },
  ]);
  f.steps = [
    { instruction: 'Enter the search', action: 'typeText', text: 'otters', expect: { textIncludes: 'Value: otters' } },
    clickStep,
  ];
  const result = await runCuaWorkflow(f);
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 2);
  assert.deepEqual(actions(f), [['typeText', 1, 'otters'], ['click', 2]]);
  assert.deepEqual(f.events.filter(([name]) => name === 'select').map(([, request]) => ({ goal: request.goal, instruction: request.instruction, text: request.observation.text })), [
    { goal: 'Find otters', instruction: 'Enter the search', text: start },
    { goal: 'Find otters', instruction: 'Continue to results', text: typed },
  ]);
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every(step => step.status === 'completed' && step.selectionMs >= 0 && step.actionMs >= 0 && step.verificationMs >= 0));
  assert.ok(result.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(result), /otters|attacker|AXWebArea|Search/);
});

test('stale reused refs stop before acting even if the selected role is unchanged', async () => {
  const f = fixture([start, start.replace('button Continue', 'button Delete'), done]);
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'STALE_OBSERVATION');
  assert.equal(result.completedSteps, 0);
  assert.deepEqual(actions(f), []);
});

test('unrelated snapshot changes also invalidate selection', async () => {
  const f = fixture([start, start.replace('AXWebArea Draft', 'AXWebArea Other'), done]);
  assert.equal((await runCuaWorkflow(f)).reason, 'STALE_OBSERVATION');
  assert.deepEqual(actions(f), []);
});

test('duplicate refs stop observation before selection', async () => {
  const f = fixture(['0 AXWebArea Draft\n2 static text Banner\n2 button Continue']);
  assert.equal((await runCuaWorkflow(f)).reason, 'INVALID_OBSERVATION');
  assert.equal(f.events.length, 1);
});

test('selector low confidence is passed through without acting', async () => {
  const f = fixture([start], [{ status: 'needs_host', reason: 'LOW_CONFIDENCE', screen: 'private screen', latencyMs: 8 }]);
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
  assert.equal(result.status, 'needs_host');
  assert.deepEqual(actions(f), []);
  assert.doesNotMatch(JSON.stringify(result), /private screen/);
});

test('validates the entire plan before any action', async () => {
  const invalidSteps = [
    { instruction: 'No postcondition', action: 'click' },
    { ...clickStep, expect: { textIncludes: '' } },
    { ...clickStep, expect: { textIncludes: 'a', textExcludes: 'b' } },
    { ...clickStep, expect: { textIncludes: 'a', evaluate: 'arbitrary code' } },
    { ...clickStep, action: 'typeText' },
    { ...clickStep, action: 'pressKey' },
    { ...clickStep, action: 'scroll', direction: 'elsewhere' },
    { ...clickStep, action: 'evaluate' },
  ];
  for (const invalid of invalidSteps) {
    const f = fixture();
    f.steps = [clickStep, invalid];
    const result = await runCuaWorkflow(f);
    assert.equal(result.reason, 'INVALID_PLAN');
    assert.equal(result.completedSteps, 0);
    assert.deepEqual(f.events, []);
  }
});

test('host gate stops before observing or selecting', async () => {
  const f = fixture();
  f.steps = [{ ...clickStep, requiresHost: true }];
  assert.equal((await runCuaWorkflow(f)).reason, 'HOST_REQUIRED');
  assert.deepEqual(f.events, []);
});

test('postcondition already met stops before selection and prevents repeated input', async () => {
  const f = fixture([done]);
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'POSTCONDITION_ALREADY_MET');
  assert.deepEqual(f.events, [['observe']]);
});

test('postcondition failure remains needs_host with no automatic repeat', async () => {
  const f = fixture([start, start, start]);
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'VERIFICATION_FAILED');
  assert.equal(result.completedSteps, 0);
  assert.deepEqual(actions(f), [['click', 2]]);
});

test('textExcludes verifies removal against fresh noninteractive content', async () => {
  const before = start + '\n3 static text Loading pending';
  const f = fixture([before, before, start]);
  f.steps = [{ ...clickStep, expect: { textExcludes: 'Loading pending' } }];
  assert.equal((await runCuaWorkflow(f)).status, 'completed');
});

test('step limit stops at an action boundary', async () => {
  const f = fixture([start, start, done]);
  f.steps = [clickStep, { ...clickStep, expect: { textIncludes: 'Another page' } }];
  const result = await runCuaWorkflow({ ...f, maxSteps: 1 });
  assert.equal(result.reason, 'MAX_STEPS');
  assert.equal(result.completedSteps, 1);
  assert.equal(actions(f).length, 1);
});

test('abort before starting performs no calls', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort('private reason');
  const result = await runCuaWorkflow({ ...f, signal: controller.signal });
  assert.equal(result.reason, 'ABORTED');
  assert.deepEqual(f.events, []);
});

test('abort during selection prevents physical action', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.selector.select = async () => { controller.abort(); return { status: 'selected', ref: 2, confidence: 1 }; };
  const result = await runCuaWorkflow({ ...f, signal: controller.signal });
  assert.equal(result.reason, 'ABORTED');
  assert.deepEqual(actions(f), []);
});

test('duration expiration during selection prevents physical action', async () => {
  const f = fixture();
  f.selector.select = async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return { status: 'selected', ref: 2, confidence: 1 };
  };
  const result = await runCuaWorkflow({ ...f, maxDurationMs: 10 });
  assert.equal(result.reason, 'TIMEOUT');
  assert.deepEqual(actions(f), []);
});

test('timeout waits for an already started physical action and reports it honestly', async () => {
  const f = fixture();
  let actionFinished = false;
  f.target.click = async ref => {
    f.events.push(['click', ref]);
    await new Promise(resolve => setTimeout(resolve, 25));
    actionFinished = true;
  };
  const result = await runCuaWorkflow({ ...f, maxDurationMs: 10 });
  assert.equal(actionFinished, true);
  assert.equal(result.reason, 'TIMEOUT_AFTER_ACTION');
  assert.equal(result.steps[0].status, 'action_performed_unverified');
  assert.equal(result.completedSteps, 0);
  assert.equal(actions(f).length, 1);
});

test('abort after physical action reports performed but unverified status', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.target.click = async ref => { f.events.push(['click', ref]); controller.abort(); };
  const result = await runCuaWorkflow({ ...f, signal: controller.signal });
  assert.equal(result.reason, 'ABORTED_AFTER_ACTION');
  assert.equal(result.steps[0].status, 'action_performed_unverified');
});

test('unobserved refs, noninteractive refs, disabled controls and password fields cannot act', async () => {
  for (const [snapshot, ref] of [
    [start, 99],
    [start, 0],
    [start.replace('button Continue', 'button (disabled) Continue'), 2],
    [start.replace('Description: Search', 'Description: Password'), 1],
    [start.replace('text field (settable, string)', 'text field (protected, settable, string)'), 1],
    [start.replace('text field (settable, string)', 'secure text field (settable, string)'), 1],
  ]) {
    const f = fixture([snapshot], [{ status: 'selected', ref, confidence: 1 }]);
    const result = await runCuaWorkflow(f);
    assert.equal(result.status, 'needs_host');
    assert.deepEqual(actions(f), []);
  }
});

test('typeText cannot target a noneditable control', async () => {
  const f = fixture();
  f.steps = [{ ...clickStep, action: 'typeText', text: 'otters' }];
  assert.equal((await runCuaWorkflow(f)).reason, 'INVALID_TARGET');
  assert.deepEqual(actions(f), []);
});

test('pressKey and scroll pass only the exact host arguments', async () => {
  for (const [step, expected] of [
    [{ ...clickStep, action: 'pressKey', key: 'ENTER' }, ['pressKey', 2, 'ENTER']],
    [{ ...clickStep, action: 'scroll', direction: 'down' }, ['scroll', 2, 'down', 1]],
  ]) {
    const f = fixture();
    f.steps = [step];
    assert.equal((await runCuaWorkflow(f)).status, 'completed');
    assert.deepEqual(actions(f), [expected]);
  }
});

test('host plan is copied before selector callbacks can mutate it', async () => {
  const f = fixture([start, start, typed], [{ status: 'selected', ref: 1, confidence: 1 }]);
  const step = { instruction: 'Enter search', action: 'typeText', text: 'otters', expect: { textIncludes: 'Value: otters' } };
  f.steps = [step];
  const select = f.selector.select;
  f.selector.select = async request => { step.text = 'injected'; step.action = 'click'; return select(request); };
  assert.equal((await runCuaWorkflow(f)).status, 'completed');
  assert.deepEqual(actions(f), [['typeText', 1, 'otters']]);
});

test('observation and action errors never expose input or screen contents', async () => {
  const f = fixture();
  f.target.getAXState = async () => { throw new Error('private observation'); };
  const observationResult = await runCuaWorkflow(f);
  assert.equal(observationResult.reason, 'OBSERVATION_FAILED');
  const g = fixture();
  g.target.click = async () => { throw new Error('private action'); };
  const actionResult = await runCuaWorkflow(g);
  assert.equal(actionResult.reason, 'ACTION_FAILED');
  assert.equal(actionResult.steps[0].status, 'action_outcome_unknown');
  assert.doesNotMatch(JSON.stringify([observationResult, actionResult]), /private/);
});

test('unresolved selection is deadline-bounded and cannot act if it later resolves', async () => {
  const f = fixture();
  let resolveSelection;
  f.selector.select = () => new Promise(resolve => { resolveSelection = resolve; });
  const result = await Promise.race([
    runCuaWorkflow({ ...f, maxDurationMs: 10 }),
    new Promise(resolve => setTimeout(() => resolve({ reason: 'TEST_TIMEOUT' }), 100)),
  ]);
  assert.equal(result.reason, 'TIMEOUT');
  resolveSelection({ status: 'selected', ref: 2, confidence: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(actions(f), []);
});

test('unresolved read is deadline-bounded', async () => {
  const f = fixture();
  f.target.getAXState = () => new Promise(() => {});
  const result = await Promise.race([
    runCuaWorkflow({ ...f, maxDurationMs: 10 }),
    new Promise(resolve => setTimeout(() => resolve({ reason: 'TEST_TIMEOUT' }), 100)),
  ]);
  assert.equal(result.reason, 'TIMEOUT');
  assert.deepEqual(actions(f), []);
});

test('abort interrupts unresolved selection without waiting for its response', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.selector.select = () => new Promise(() => { setTimeout(() => controller.abort(), 5); });
  const result = await Promise.race([
    runCuaWorkflow({ ...f, signal: controller.signal }),
    new Promise(resolve => setTimeout(() => resolve({ reason: 'TEST_TIMEOUT' }), 100)),
  ]);
  assert.equal(result.reason, 'ABORTED');
});

test('concurrent workflows cannot overlap physical actions on the same target', async () => {
  const f = fixture();
  let releaseAction;
  let announceAction;
  const actionStarted = new Promise(resolve => { announceAction = resolve; });
  f.target.click = () => new Promise(resolve => { releaseAction = resolve; announceAction(); });
  const first = runCuaWorkflow(f);
  await actionStarted;
  const second = await runCuaWorkflow(f);
  assert.equal(second.reason, 'TARGET_BUSY');
  releaseAction();
  assert.equal((await first).status, 'completed');
});

test('prepareWorkflowPlan validates and copies the complete plan without effects', () => {
  assert.equal(typeof cua.prepareWorkflowPlan, 'function');
  const original = { goal: 'Find otters', steps: [{ ...clickStep, expect: { textIncludes: 'Results' } }] };
  const prepared = cua.prepareWorkflowPlan(original);
  assert.equal(prepared.maxSteps, 12);
  assert.equal(prepared.maxDurationMs, 45000);
  assert.equal(prepared.verificationTimeoutMs, 0);
  original.steps[0].instruction = 'Changed';
  original.steps[0].expect.textIncludes = 'Changed';
  assert.equal(prepared.steps[0].instruction, clickStep.instruction);
  assert.equal(prepared.steps[0].expect.textIncludes, 'Results');
  for (const invalid of [null, {}, { ...original, goal: ' ' }, { ...original, maxSteps: 0 }, { ...original, maxDurationMs: -1 }, { ...original, verificationTimeoutMs: -1 }, { ...original, verificationTimeoutMs: Infinity }, { ...original, steps: [clickStep, { action: 'click' }] }]) {
    assert.equal(cua.prepareWorkflowPlan(invalid), null);
  }
});

test('bounded verification observes delayed success without selecting or acting again', async () => {
  const f = fixture([start, start, start, done]);
  const result = await runCuaWorkflow({ ...f, verificationTimeoutMs: 300 });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 1);
  assert.deepEqual(actions(f), [['click', 2]]);
  assert.equal(f.events.filter(([name]) => name === 'select').length, 1);
  assert.equal(f.events.filter(([name]) => name === 'observe').length, 4);
});

test('verification expiry stops without retrying the physical action', async () => {
  const f = fixture([start]);
  const result = await runCuaWorkflow({ ...f, verificationTimeoutMs: 75 });
  assert.equal(result.reason, 'VERIFICATION_FAILED');
  assert.equal(result.completedSteps, 0);
  assert.deepEqual(actions(f), [['click', 2]]);
  assert.equal(f.events.filter(([name]) => name === 'select').length, 1);
  assert.ok(f.events.filter(([name]) => name === 'observe').length > 3);
});

test('abort during verification polling stops after one performed action', async () => {
  const f = fixture([start]);
  const controller = new AbortController();
  f.target.click = async ref => {
    f.events.push(['click', ref]);
    setTimeout(() => controller.abort(), 15);
  };
  const result = await runCuaWorkflow({ ...f, signal: controller.signal, verificationTimeoutMs: 1000 });
  assert.equal(result.reason, 'ABORTED_AFTER_ACTION');
  assert.equal(result.steps[0].status, 'action_performed_unverified');
  assert.deepEqual(actions(f), [['click', 2]]);
});

test('global deadline caps a longer verification window', async () => {
  const f = fixture([start]);
  const result = await runCuaWorkflow({ ...f, maxDurationMs: 100, verificationTimeoutMs: 1000 });
  assert.equal(result.reason, 'TIMEOUT_AFTER_ACTION');
  assert.equal(result.steps[0].status, 'action_performed_unverified');
  assert.deepEqual(actions(f), [['click', 2]]);
  assert.ok(result.durationMs < 1000);
});

test('observation errors during verification stop immediately without polling retries', async () => {
  const f = fixture([start]);
  const read = f.target.getAXState;
  let reads = 0;
  f.target.getAXState = async options => {
    if (++reads >= 3) throw new Error('private detail');
    return read(options);
  };
  const result = await runCuaWorkflow({ ...f, verificationTimeoutMs: 1000 });
  assert.equal(result.reason, 'OBSERVATION_FAILED');
  assert.equal(reads, 3);
  assert.deepEqual(actions(f), [['click', 2]]);
});

test('fixed workflows remap a stable target across unrelated DOM and ref changes', async () => {
  let reads = 0, clicked = false;
  const target = {
    async getObservation() { return { text: clicked ? 'Done' : `Banner ${++reads}`,
      url: 'https://example.test', title: 'Page', elements: [
        { ref: reads === 1 ? 2 : 9, role: 'button', name: 'Continue', identity: 'stable-id' },
      ] }; },
    async click(ref) { assert.equal(ref, 9); clicked = true; },
  };
  const result = await runCuaWorkflow({ target, goal: 'Continue',
    steps: [{ instruction: 'Continue', action: 'click', expect: { textIncludes: 'Done' } }],
    selector: { async select() { return { status: 'selected', ref: 2, confidence: 1 }; } },
  });
  assert.equal(result.status, 'completed');
});

test('fixed workflows retain sanitized adapter errors and proven no-dispatch outcomes', async () => {
  const f = fixture();
  f.target.click = async () => { throw Object.assign(new Error('private page'), {
    code: 'LOCATOR_ENGINE_FAILED', detail: 'CDP_CONNECTION_FAILED', actionDispatched: false,
  }); };
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'ACTION_FAILED');
  assert.equal(result.detail, 'CDP_CONNECTION_FAILED');
  assert.equal(result.steps[0].errorCode, 'LOCATOR_ENGINE_FAILED');
  assert.equal(result.steps[0].status, 'action_not_dispatched');
  assert.doesNotMatch(JSON.stringify(result), /private page/);
});

test('scoped fixed steps expose only approved candidates while retaining full verification text', async () => {
  const f = fixture();
  f.steps = [{ ...clickStep, target: { roles: ['button'], nameEquals: 'Continue' } }];
  let selectedElements, selectedText;
  f.selector.select = async input => { selectedElements = input.observation.elements; selectedText = input.observation.text;
    return { status: 'selected', ref: 2, confidence: 1 }; };
  const result = await runCuaWorkflow(f);
  assert.equal(result.status, 'completed');
  assert.deepEqual(selectedElements.map(element => element.ref), [2]);
  assert.equal(selectedText, start);
  assert.equal(result.steps[0].selectedRef, 2);
  assert.equal(result.steps[0].executedRef, 2);
});

test('a selector cannot escape fixed-step target restrictions with another valid page ref', async () => {
  const f = fixture([start], [{ status: 'selected', ref: 1, confidence: 1 }]);
  f.steps = [{ ...clickStep, target: { roles: ['button'], nameEquals: 'Continue' } }];
  const result = await runCuaWorkflow(f);
  assert.equal(result.reason, 'INVALID_TARGET');
  assert.equal(result.steps[0].selectedRef, 1);
  assert.equal(result.steps[0].executedRef, undefined);
  assert.deepEqual(actions(f), []);
});

test('a scoped fixed step without eligible candidates stops before the selector call', async () => {
  const f = fixture();
  f.steps = [{ ...clickStep, target: { roles: ['link'], nameEquals: 'Unavailable' } }];
  f.selector.select = async () => assert.fail('no eligible target must not consume an API request');
  assert.equal((await runCuaWorkflow(f)).reason, 'NO_SAFE_TARGET');
  assert.deepEqual(actions(f), []);
});

test('fixed-step filters are validated, copied and frozen before observation callbacks', async () => {
  const target = { roles: ['button'], nameIncludes: 'Continue' };
  const prepared = cua.prepareWorkflowPlan({ goal: 'Continue', steps: [{ ...clickStep, target }] });
  assert.deepEqual(prepared.steps[0].target, target);
  assert.ok(Object.isFrozen(prepared.steps[0].target));
  assert.ok(Object.isFrozen(prepared.steps[0].target.roles));
  target.roles.push('text field'); target.nameIncludes = 'Search';
  assert.deepEqual(prepared.steps[0].target, { roles: ['button'], nameIncludes: 'Continue' });
  for (const bad of [null, 'button', { roles: [] }, { nameEquals: '' }]) {
    assert.equal(cua.prepareWorkflowPlan({ goal: 'Continue', steps: [{ ...clickStep, target: bad }] }), null);
  }
});

test('fixed-step host filter mutation during selection cannot authorize a different target', async () => {
  const f = fixture();
  const filter = { roles: ['button'], nameEquals: 'Continue' };
  f.steps = [{ ...clickStep, target: filter }];
  f.selector.select = async () => { filter.roles.push('text field'); delete filter.nameEquals;
    return { status: 'selected', ref: 1, confidence: 1 }; };
  assert.equal((await runCuaWorkflow(f)).reason, 'INVALID_TARGET');
  assert.deepEqual(actions(f), []);
});
