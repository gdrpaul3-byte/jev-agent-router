import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../src/inference-budget.mjs', import.meta.url);
const load = async () => { try { return await import(moduleUrl); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; } };
const url = 'https://openrouter.ai/api/v1/chat/completions';
const init = () => ({ method: 'POST', body: JSON.stringify({ model: 'openai/gpt-6-astra', max_tokens: 1024 }), signal: new AbortController().signal });
const reply = (cost = 0.01) => new Response(JSON.stringify({ usage: { cost } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('budget reserves before dispatch and counts each charged call exactly once', async () => {
  const { createInferenceBudget } = await load();
  assert.equal(typeof createInferenceBudget, 'function');
  let calls = 0;
  const meter = createInferenceBudget({ budgetUsd: 1, maxRequests: 1, fetchImpl: async () => { calls++; return reply(); } });
  const response = await meter.fetchImpl(url, init());
  assert.equal((await response.json()).usage.cost, 0.01);
  await assert.rejects(meter.fetchImpl(url, init()), /CALL_BUDGET_EXHAUSTED/);
  assert.equal(calls, 1);
  assert.equal(meter.summary().accountedProviderUsd, 0.01);
  assert.equal(meter.summary().requests, 1);
});

test('insufficient reservation and disallowed endpoint/model never dispatch', async () => {
  const { createInferenceBudget } = await load();
  let calls = 0;
  const meter = createInferenceBudget({ budgetUsd: 0.00001, maxRequests: 3, fetchImpl: async () => { calls++; return reply(); } });
  await assert.rejects(meter.fetchImpl(url, init()), /COST_BUDGET_EXHAUSTED/);
  await assert.rejects(meter.fetchImpl('https://attacker.invalid', init()), /ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(meter.fetchImpl(url, { ...init(), body: '{"model":"other","max_tokens":100}' }), /INVALID_BUDGET_REQUEST/);
  assert.equal(calls, 0);
});

test('missing cost stops future calls and remains unknown rather than zero', async () => {
  const { createInferenceBudget } = await load();
  const meter = createInferenceBudget({ budgetUsd: 1, maxRequests: 4, fetchImpl: async () => reply(null) });
  await meter.fetchImpl(url, init());
  await assert.rejects(meter.fetchImpl(url, init()), /UNACCOUNTED_REQUEST/);
  assert.equal(meter.summary().accountedProviderUsd, null);
  assert.equal(meter.records()[0].costComplete, false);
});

test('JEV uses input usage estimate and never combines overlapping OpenRouter upstream cost', async () => {
  const { createInferenceBudget } = await load();
  const responses = [new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 1000 } })), new Response(JSON.stringify({ usage: { cost: 0.1, cost_details: { upstream_inference_cost: 0.1 } } }))];
  const meter = createInferenceBudget({ budgetUsd: 2, maxRequests: 2, fetchImpl: async () => responses.shift() });
  await meter.fetchImpl('https://api.typesafe.ai/v1/systemone', { ...init(), body: '{"model":"jev-1.13.0"}' });
  await meter.fetchImpl(url, init());
  assert.equal(meter.summary().estimatedProviderUsd, 0.000042);
  assert.equal(meter.summary().reportedProviderUsd, 0.1);
  assert.equal(meter.summary().accountedProviderUsd, 0.100042);
});

test('unpriced JEV model cannot be billed at the pinned model rate', async () => {
  const { createInferenceBudget } = await load();
  const meter = createInferenceBudget({ fetchImpl: async () => new Response(JSON.stringify({ model: 'jev-new-unpriced', usage: { input_tokens: 1000 } })) });
  await meter.fetchImpl('https://api.typesafe.ai/v1/systemone', { ...init(), body: '{"model":"jev-1.13.0"}' });
  assert.equal(meter.summary().accountedProviderUsd, null);
  assert.equal(meter.records()[0].estimatedProviderUsd, null);
});

test('BYOK evidence is retained and blocks a pilot whose reservation only bounds account credit charges', async () => {
  const { createInferenceBudget } = await load();
  const meter = createInferenceBudget({ fetchImpl: async () => new Response(JSON.stringify({ usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.5 } } })) });
  await meter.fetchImpl(url, init());
  assert.equal(meter.records()[0].isByok, true);
  assert.equal(meter.records()[0].upstreamInferenceCostUsd, 0.5);
  assert.equal(meter.summary().blockedReason, 'BYOK_SCOPE_UNSUPPORTED');
  await assert.rejects(meter.fetchImpl(url, init()), /BYOK_SCOPE_UNSUPPORTED/);
});

test('transport uncertainty is preserved and no request can overtake an active reservation', async () => {
  const { createInferenceBudget } = await load();
  let release;
  const meter = createInferenceBudget({ budgetUsd: 2, maxRequests: 3, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const first = meter.fetchImpl(url, init());
  await assert.rejects(meter.fetchImpl(url, init()), /UNACCOUNTED_REQUEST/);
  release(reply()); await first;
  assert.equal(meter.summary().requests, 1);
  const broken = createInferenceBudget({ budgetUsd: 2, maxRequests: 3, fetchImpl: async () => { throw new Error('secret!'); } });
  await assert.rejects(broken.fetchImpl(url, init()), /TRANSPORT_FAILED/);
  assert.equal(JSON.stringify(broken.records()).includes('secret'), false);
  await assert.rejects(broken.fetchImpl(url, init()), /UNACCOUNTED_REQUEST/);
});

test('late response after abort cannot turn uncertain accounting into a known successful record', async () => {
  const { createInferenceBudget } = await load();
  let release;
  const controller = new AbortController();
  const meter = createInferenceBudget({ budgetUsd: 2, maxRequests: 3, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = meter.fetchImpl(url, { ...init(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /TRANSPORT_FAILED/);
  release(reply()); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(meter.summary().accountedProviderUsd, null);
  assert.equal(meter.records()[0].error, 'TRANSPORT_FAILED');
});
