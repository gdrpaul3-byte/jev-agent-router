import test from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceBudget } from '../src/inference-budget.mjs';

const origin = 'https://www.hsmu.ac.kr';
const paths = ['/web/main/index.do', '/web/main/index.do', '/web/contents/HSMU10501000.do',
  '/web/contents/HSMU10501000.do', '/web/contents/HSMU10502000.do', '/web/contents/HSMU10401000.do'];
const ids = ['openMainMenu', 'openGreeting', 'openProfileMenu', 'openProfile', 'openDirections'];
const facts = { seoulStationBus: '5101', mainPhone: '031-369-9100~1', shuttleFare: '무료' };
async function subject() { return import('../benchmarks/hsmu-browser-compare.mjs'); }
function setup({ skipPages = false, noHeadings = false, domHeadings = false, mismatchedEvidence = false, forgedBodyHeading = false, initialStage = 0, failResponse = false } = {}) {
  let stage = initialStage; const posts = [], clicks = [];
  const observation = () => {
    const heading = stage === 2 || stage === 3 ? '총장 인사말' : stage === 4 ? '총장 프로필' : stage === 5 ? '오시는 길' : '화성의과학대학교';
    return { url: origin + paths[stage], title: heading,
      ...(domHeadings ? { headingEvidence: { source: 'visible-dom-headings', url: origin + paths[mismatchedEvidence ? 0 : stage], title: heading, headings: [heading] } } : {}),
      text: `0 AXWebArea HSMU\n1 ${(noHeadings || domHeadings) && !forgedBodyHeading ? 'link' : 'heading (level 2)'} ${heading}\nphase${stage}\n`
      + (stage === 5 ? '대중교통 이용 시\n서울역 5101\n대표전화 031-369-9100~1\n셔틀버스 탑승요금 무료\n' : '') + 'PRIVATE_AX_MARKER',
      elements: [stage === 0 ? { ref: 10, role: 'link', name: 'H' } : stage === 1 ? { ref: 11, role: 'link', name: '총장 인사말' }
        : stage === 2 ? { ref: 12, role: 'button', name: '총장 인사말' } : stage === 3 ? { ref: 13, role: 'link', name: '총장 프로필' }
          : { ref: 14, role: 'link', name: '오시는 길' }, ...(stage < 4 ? [{ ref: 14, role: 'link', name: '오시는 길' }] : [])] };
  };
  const target = { getObservation: async () => observation(), click: async ref => { clicks.push(ref); stage = ref === 14 ? 5 : stage + 1; } };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); posts.push({ url, body });
    if (failResponse) return Response.json({ error: { message: 'PRIVATE_ERROR' }, usage: { cost: .004, is_byok: false } }, { status: 401 });
    const final = body.response_format?.json_schema?.schema?.properties?.seoulStationBus;
    if (final) {
      assert.equal(body.model, 'openai/gpt-6-astra');
      const payload = JSON.parse(body.messages[1].content[1].text);
      assert.equal(payload.sourceUrl, origin + paths[5]); assert.match(payload.observationText, /서울역 5101/);
      assert.ok(!Object.hasOwn(payload, 'expected'));
    }
    const selected = stage === 5 ? 'DONE' : skipPages ? 'openDirections' : ids[stage];
    const ref = skipPages ? 14 : 10 + stage;
    if (url === 'https://api.typesafe.ai/v1/systemone') {
      assert.equal(body.model, 'jev-1.13.0');
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const keys = Object.keys(question.criteria), choice = id === 'operation' ? selected
          : id === `target_${selected}` ? `e_${ref}` : 'NONE';
        return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 100 }, answers });
    }
    const value = final ? facts : selected === 'DONE' ? { status: 'done', actionId: 'NONE', ref: -1, confidence: 1 }
      : { status: 'decided', actionId: selected, ref, confidence: 1 };
    return Response.json({ model: 'openai/gpt-6-astra', provider: 'OpenAI', service_tier: 'default',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 10 }, cost: final ? .01 : .005, is_byok: false } });
  };
  return { target, fetchImpl, posts, clicks };
}

test('same frozen five-action browser plan completes both arms with actual ordered visits and common final extraction', async () => {
  const { HSMU_BROWSER_PLAN, runHsmuBrowserComparison } = await subject();
  assert.ok(Object.isFrozen(HSMU_BROWSER_PLAN)); assert.ok(Object.isFrozen(HSMU_BROWSER_PLAN.actions));
  assert.equal(HSMU_BROWSER_PLAN.maxStaleReplans, 2); assert.equal(HSMU_BROWSER_PLAN.verificationTimeoutMs, 30000);
  const finalRequests = [];
  for (const arm of ['astra', 'jev']) {
    const f = setup(), report = await runHsmuBrowserComparison({ target: f.target, arm, apiKeys: { typesafe: 'test', openrouter: 'test' }, fetchImpl: f.fetchImpl });
    assert.equal(report.passed, true); assert.equal(report.status, 'completed'); assert.equal(report.requests, 7);
    assert.deepEqual(f.clicks, [10, 11, 12, 13, 14]); assert.deepEqual(report.facts, facts);
    assert.equal(report.validation.visitedInOrder, true); assert.ok(report.visits.every(visit => visit.urlVerified && visit.headingVerified));
    assert.equal(report.cost.complete, true); assert.equal(report.requestEvidence.length, 7);
    assert.equal(report.decisionStats.calls, 6); assert.equal(report.decisionStats.inputTokens, 6000);
    assert.equal(report.decisionAttempts.length, arm === 'astra' ? 6 : 0);
    assert.equal(report.navigation.metrics.staleReplans, 0); assert.deepEqual(report.navigation.replans, []);
    assert.ok(Math.abs(report.cost.accountedProviderUsd - (arm === 'astra' ? .04 : .010252)) < 1e-10);
    assert.ok(!JSON.stringify(report).includes('PRIVATE_AX_MARKER')); assert.ok(!JSON.stringify(report).includes('Bearer test'));
    finalRequests.push(f.posts.at(-1).body);
  }
  assert.deepEqual(finalRequests[0], finalRequests[1]);
});

test('coherent visible DOM heading evidence verifies real pages without invented AX rows; mismatched URL does not', async () => {
  const { runHsmuBrowserComparison } = await subject();
  for (const mismatchedEvidence of [false, true]) {
    const f = setup({ domHeadings: true, mismatchedEvidence, forgedBodyHeading: mismatchedEvidence });
    const report = await runHsmuBrowserComparison({ target: f.target, arm: 'astra', apiKeys: { openrouter: 'test' }, fetchImpl: f.fetchImpl });
    assert.equal(report.passed, !mismatchedEvidence);
    assert.equal(report.validation.visitedInOrder, !mismatchedEvidence);
  }
});

test('final URL alone or link text pretending to be a heading cannot pass or trigger extraction', async () => {
  const { runHsmuBrowserComparison } = await subject();
  for (const options of [{ skipPages: true }, { noHeadings: true }]) {
    const f = setup(options), report = await runHsmuBrowserComparison({ target: f.target, arm: 'astra', apiKeys: { openrouter: 'test' }, fetchImpl: f.fetchImpl });
    assert.equal(report.passed, false); assert.equal(report.validation.visitedInOrder, false); assert.equal(report.facts, null);
    assert.ok(f.posts.every(post => !post.body.response_format?.json_schema?.schema?.properties?.seoulStationBus));
  }
});

test('shared global budget is charged once, per-run deltas exclude earlier calls, and cap blocks another paid run', async () => {
  const { runHsmuBrowserComparison } = await subject(); let active = setup();
  const budget = createInferenceBudget({ fetchImpl: (...args) => active.fetchImpl(...args), maxRequests: 7, budgetUsd: 5 });
  const first = await runHsmuBrowserComparison({ target: active.target, arm: 'jev', apiKeys: { typesafe: 'test', openrouter: 'test' }, budget });
  assert.equal(first.requests, 7); active = setup();
  const second = await runHsmuBrowserComparison({ target: active.target, arm: 'astra', apiKeys: { openrouter: 'test' }, budget });
  assert.equal(second.requests, 0); assert.equal(active.posts.length, 0); assert.equal(second.passed, false);
  assert.equal(second.globalAccounting.requests, 7); assert.equal(second.cost.accountedProviderUsd, 0);
  assert.equal(second.reason, 'CALL_BUDGET_EXHAUSTED');
});

test('HTTP failure preserves charges, wrong start URL prevents any inference, and error text is never returned', async () => {
  const { runHsmuBrowserComparison } = await subject();
  const failed = setup({ failResponse: true }), result = await runHsmuBrowserComparison({ target: failed.target, arm: 'astra', apiKeys: { openrouter: 'test' }, fetchImpl: failed.fetchImpl });
  assert.equal(result.passed, false); assert.equal(result.requests, 1); assert.equal(result.cost.accountedProviderUsd, .004);
  assert.equal(result.facts, null); assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
  const wrong = setup({ initialStage: 4 });
  const stopped = await runHsmuBrowserComparison({ target: wrong.target, arm: 'astra', apiKeys: { openrouter: 'test' }, fetchImpl: () => assert.fail('No request from wrong starting page') });
  assert.equal(stopped.reason, 'INVALID_START_URL'); assert.equal(stopped.requests, 0);
});

test('JEV also requires the common extraction credential before browser observation or paid navigation', async () => {
  const { runHsmuBrowserComparison } = await subject();
  const target = { getObservation: () => assert.fail('No browser read before credential validation'), click: () => assert.fail('No action') };
  const result = await runHsmuBrowserComparison({ target, arm: 'jev', apiKeys: { typesafe: 'test' }, fetchImpl: () => assert.fail('No paid call') });
  assert.equal(result.reason, 'MISSING_API_KEY'); assert.equal(result.requests, 0);
});
