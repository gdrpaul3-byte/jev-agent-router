import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserPlan } from '../src/browser-run.mjs';
import { demoSteps } from '../examples/offline.mjs';

const plan = { url: 'https://example.com/', goal: 'Open guide', steps: demoSteps };
test('missing key stops before launching a browser', async () => {
  const result = await runBrowserPlan({ plan, playwrightImpl: { chromium: { launch: () => { throw new Error('must not launch'); } } } });
  assert.equal(result.reason, 'MISSING_API_KEY');
});
test('rejects filesystem and credential-bearing start URLs', async () => {
  for (const url of ['file:///C:/private', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.equal((await runBrowserPlan({ plan: { ...plan, url } })).reason, 'INVALID_START_URL');
  }
});
test('browser launch errors do not reveal private driver diagnostics', async () => {
  const result = await runBrowserPlan({ plan, apiKey: 'fake-key', playwrightImpl: { chromium: { launch: () => { throw new Error('private-profile-token'); } } } });
  assert.equal(result.reason, 'BROWSER_FAILED');
  assert.equal(JSON.stringify(result).includes('private-profile-token'), false);
});

test('invalid complete plans stop before key reads, imports, launch or navigation', async () => {
  const invalidPlans = [
    { ...plan, goal: ' ' },
    { ...plan, steps: [...plan.steps, { instruction: 'Missing postcondition', action: 'click' }] },
    { ...plan, steps: [...plan.steps, { instruction: 'Invalid action', action: 'evaluate', expect: { textIncludes: 'Done' } }] },
    { ...plan, maxSteps: 0 },
    { ...plan, maxDurationMs: -1 },
    { ...plan, verificationTimeoutMs: -1 },
  ];
  for (const invalidPlan of invalidPlans) {
    let launches = 0;
    const result = await runBrowserPlan({ plan: invalidPlan, envFile: 'must-not-read.env', playwrightImpl: { chromium: { launch: () => { launches++; throw new Error('must not launch'); } } } });
    assert.equal(result.reason, 'INVALID_PLAN');
    assert.equal(launches, 0);
  }
});

test('invalid injected selectors stop before a browser launch', async () => {
  for (const selector of [{}, { select: 'not callable' }, null]) {
    let launches = 0;
    const result = await runBrowserPlan({ plan, selector, playwrightImpl: { chromium: { launch: () => { launches++; throw new Error('must not launch'); } } } });
    assert.equal(result.reason, 'INVALID_PLAN');
    assert.equal(launches, 0);
  }
});

test('standalone browser waits for a delayed postcondition and runs one action', async () => {
  let actionCount = 0;
  let readsAfterAction = 0;
  let closed = false;
  const page = {
    setDefaultTimeout() {},
    async goto() {},
    async evaluate() {
      const finished = actionCount > 0 && ++readsAfterAction >= 2;
      return { title: 'Example', url: plan.url, text: finished ? 'Finished' : 'Ready', candidateCount: 1,
        elements: [{ ref: 0, role: 'button', name: 'Continue', editable: false, identity: 'continue-button' }] };
    },
    locator() { return { nth() { return { async click() { actionCount++; } }; } }; },
  };
  const playwrightImpl = { chromium: { async launch() { return {
    async newContext() { return { async newPage() { return page; } }; },
    async close() { closed = true; },
  }; } } };
  const result = await runBrowserPlan({
    plan: { ...plan, steps: [{ instruction: 'Continue', action: 'click', expect: { textIncludes: 'Finished' } }] },
    selector: { async select() { return { status: 'selected', ref: 0, confidence: 1 }; } },
    playwrightImpl,
  });
  assert.equal(result.status, 'completed');
  assert.equal(actionCount, 1);
  assert.equal(readsAfterAction, 2);
  assert.equal(closed, true);
});
