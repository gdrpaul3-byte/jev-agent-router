import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';

const input = () => ({ task: { id: 'job', revision: 1, request: 'Prepare a draft', evidence: [{ id: 'e1', text: 'Supplied facts' }] },
  routes: [{ id: 'draft', description: 'Write an internal draft', kind: 'draft' },
    { id: 'publish', description: 'Publish the completed draft', kind: 'write' }], baselineRouteId: 'draft' });
const keys = { typesafe: 'fake-typesafe', openrouter: 'fake-openrouter' };
const noCall = () => assert.fail('No dispatch allowed');
async function temp(t) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(join(parent, 'adaptive-router-'));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(parent + sep) && basename(dir).startsWith('adaptive-router-'));
    return rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return dir;
}
async function subject() { return import('../src/adaptive-router.mjs'); }
function adapters(calls = [], route = 'draft') {
  return { fetchImpl: async () => Response.json({}),
    decideRouteBatch: async (_, options) => { calls.push('jev'); await options.fetchImpl('https://api.typesafe.ai/v1/systemone', { method: 'POST' });
      return { status: 'decided', decisions: [{ status: 'selected', routeId: route, model: 'jev-1.13.0' }],
        latencyMs: 1, cost: { estimatedJevUsd: 0.001, complete: true, inputTokens: 10, outputTokens: 0 }, requests: [{}] }; },
    runStructuredRequest: async (request, options) => { calls.push(request.model); await options.fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      return { status: 'ok', value: { routeId: route }, requests: 1, latencyMs: 1, usage: { inputTokens: 10 },
        cost: { reportedProviderUsd: 0.002, complete: true, isByok: false }, observedModel: request.model, observedProvider: 'OpenAI' }; },
  };
}

test('offline preparation defaults to JEV and never treats predicted prompt caching as confirmed', async () => {
  const { prepareAdaptiveRoute } = await subject();
  const result = prepareAdaptiveRoute(input());
  assert.equal(result.status, 'preflight'); assert.equal(result.selection.provider, 'jev');
  assert.equal(result.cache.ttlSeconds, 300); assert.equal(result.cache.exactOnly, true);
  assert.equal(result.selection.providerCacheHitConfirmed, false); assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes('Supplied facts'));
});

test('trusted complex work selects Astra and routine Luna requires recent eligible cost observations', async () => {
  const { prepareAdaptiveRoute } = await subject(); const now = 2000000;
  assert.equal(prepareAdaptiveRoute(input(), { config: { difficulty: 'complex' }, now: () => now }).selection.provider, 'astra');
  const estimates = { luna: { qualityEligible: true, expectedCostUsd: 0.00001, expectedLatencyMs: 1, cacheObservedAt: now - 1000 } };
  assert.equal(prepareAdaptiveRoute(input(), { config: { estimates }, now: () => now }).selection.provider, 'luna');
  estimates.luna.cacheObservedAt = now - 300001;
  assert.equal(prepareAdaptiveRoute(input(), { config: { estimates }, now: () => now }).selection.provider, 'jev');
  estimates.luna.cacheObservedAt = now; estimates.luna.qualityEligible = false;
  assert.equal(prepareAdaptiveRoute(input(), { config: { estimates }, now: () => now }).selection.provider, 'jev');
  estimates.luna.cacheObservedAt = now + 1; estimates.luna.qualityEligible = true;
  assert.equal(prepareAdaptiveRoute(input(), { config: { estimates }, now: () => now }).selection.provider, 'jev');
});

test('accepted decisions replay from exact private state at zero current cost and fresh host approval', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), calls = [];
  const first = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...adapters(calls, 'publish') });
  assert.equal(first.status, 'selected'); assert.equal(first.requiresHostApproval, true); assert.equal(first.executionClaimed, false);
  const replay = await runAdaptiveRoute(input(), { stateDir, apiKeys: new Proxy({}, { get: noCall }), fetchImpl: noCall });
  assert.equal(replay.cacheHit, true); assert.equal(replay.requests, 0); assert.equal(replay.cost.accountedProviderUsd, 0);
  assert.equal(replay.decisionRequests, 1); assert.equal(replay.decisionCost.estimatedProviderUsd, 0.001);
  assert.equal(replay.requiresFreshHostValidation, true); assert.deepEqual(calls, ['jev']);
});

test('evidence availability approval purpose namespace scope and model strategy changes invalidate cache', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), calls = [];
  await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...adapters(calls) });
  const variants = [value => { value.task.evidence[0].text = 'changed'; }, value => { value.routes[1].available = false; },
    value => { value.routes[0].requiresApproval = true; }, value => { value.task.request = 'Different purpose'; }];
  for (const mutate of variants) { const value = input(); mutate(value); const result = await runAdaptiveRoute(value, { stateDir, apiKeys: keys, ...adapters(calls) }); assert.equal(result.cacheHit, false); }
  for (const config of [{ namespace: 'other' }, { scope: 'other' }, { strategy: 'astra' }]) {
    assert.equal((await runAdaptiveRoute(input(), { config, stateDir, apiKeys: keys, ...adapters(calls) })).cacheHit, false);
  }
  assert.equal(calls.length, 8);
});

test('TTL expires accepted cache and pending or uncertain attempts never automatically retry', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), calls = []; let time = 1000000;
  const options = { stateDir, apiKeys: keys, ...adapters(calls), now: () => time };
  await runAdaptiveRoute(input(), options); time += 300001;
  assert.equal((await runAdaptiveRoute(input(), options)).cacheHit, false); assert.equal(calls.length, 2);
  const uncertainInput = input(); uncertainInput.task.id = 'uncertain';
  const uncertain = await runAdaptiveRoute(uncertainInput, { ...options, decideRouteBatch: async (_, opts) => {
    await opts.fetchImpl('https://api.typesafe.ai/v1/systemone', { method: 'POST' }); throw new Error('secret-error');
  } });
  assert.equal(uncertain.status, 'needs_host'); assert.equal(uncertain.requests, 1); assert.equal(uncertain.cost.accountedProviderUsd, null);
  const replay = await runAdaptiveRoute(uncertainInput, { ...options, fetchImpl: noCall });
  assert.equal(replay.reason, 'PRIOR_ATTEMPT_REQUIRES_REVIEW'); assert.equal(replay.requests, 0); assert.equal(replay.cacheHit, false);
  const state = JSON.parse(await readFile(join(stateDir, 'adaptive-state.json'), 'utf8'));
  const key = Object.keys(state.jobs)[0]; state.jobs[key].state = 'pending'; delete state.jobs[key].result;
  await writeFile(join(stateDir, 'adaptive-state.json'), JSON.stringify(state));
  assert.equal((await runAdaptiveRoute(input(), { ...options, fetchImpl: noCall })).reason, 'UNCERTAIN_PRIOR_ATTEMPT');
});

test('only supported JEV abstention escalates once within remaining calls and estimated budget', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), calls = [], injected = adapters(calls);
  const result = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...injected,
    decideRouteBatch: async (value, options) => ({ ...await injected.decideRouteBatch(value, options),
      decisions: [{ status: 'needs_host', reason: 'LOW_CONFIDENCE' }] }),
  });
  assert.equal(result.status, 'selected'); assert.deepEqual(calls, ['jev', 'openai/gpt-6-astra']); assert.equal(result.requests, 2);
  for (const config of [{ maxCalls: 1 }, { budgetUsd: 0.006 }]) {
    const state = await temp(t), limited = await runAdaptiveRoute(input(), { stateDir: state, apiKeys: keys, config, ...injected,
      decideRouteBatch: async (value, options) => ({ ...await injected.decideRouteBatch(value, options), decisions: [{ status: 'needs_host', reason: 'NO_SAFE_ROUTE' }] }),
    });
    assert.equal(limited.status, 'needs_host'); assert.equal(limited.requests, 1);
  }
});

test('transport errors never escalate and locks never auto recover', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), injected = adapters();
  const result = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...injected, runStructuredRequest: noCall,
    decideRouteBatch: async (value, options) => ({ ...await injected.decideRouteBatch(value, options), status: 'needs_host', reason: 'TIMEOUT' }),
  });
  assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.requests, 1);
  await writeFile(join(stateDir, '.adaptive-router.lock'), 'stale');
  assert.equal((await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, fetchImpl: noCall })).reason, 'STATE_LOCKED');
});

test('prepaid budget and credential checks dispatch zero calls; adapter cannot exceed network cap', async t => {
  const { runAdaptiveRoute } = await subject();
  for (const options of [{ config: { budgetUsd: 0 } }, { apiKeys: {} }, { config: { maxCalls: 0 } }]) {
    const result = await runAdaptiveRoute(input(), { stateDir: await temp(t), apiKeys: keys, ...options, ...adapters(), fetchImpl: noCall });
    assert.equal(result.status, 'needs_host'); assert.equal(result.requests, 0);
  }
  let calls = 0;
  const result = await runAdaptiveRoute(input(), { stateDir: await temp(t), apiKeys: keys,
    runStructuredRequest: noCall,
    fetchImpl: async () => { calls++; return Response.json({}); },
    decideRouteBatch: async (_, options) => { for (let i = 0; i < 3; i++) await options.fetchImpl('https://api.typesafe.ai/v1/systemone', { method: 'POST' }); },
  });
  assert.equal(calls, 1); assert.equal(result.status, 'needs_host');
});

test('recent successful Luna prefix-cache observations guide subsequent adaptive calls without paid probing', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), calls = [], base = adapters(calls); let time = 2000000;
  const injected = { ...base, runStructuredRequest: async (request, options) => ({ ...await base.runStructuredRequest(request, options),
    usage: { inputTokens: 100, cachedInputTokens: 80 }, cost: { reportedProviderUsd: 0.00001, complete: true, isByok: false } }) };
  await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, config: { strategy: 'luna' }, now: () => time, ...injected });
  const first = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now: () => time, ...injected });
  assert.equal(first.selection.provider, 'luna'); assert.equal(first.selection.estimatesSource, 'local_provider_observation');
  assert.equal(first.selection.providerCacheHitConfirmed, false); assert.equal(first.requests, 1);
  const replay = await runAdaptiveRoute(input(), { stateDir, now: () => time, fetchImpl: noCall });
  assert.equal(replay.cacheHit, true); assert.equal(replay.fingerprint, first.fingerprint); assert.equal(replay.selection.provider, 'luna');
  const other = input(); other.task.id = 'second'; time += 300001;
  assert.equal((await runAdaptiveRoute(other, { stateDir, apiKeys: keys, now: () => time, ...injected })).selection.provider, 'jev');
  assert.deepEqual(calls, ['openai/gpt-6-luna', 'openai/gpt-6-luna', 'jev']);
});

test('adaptive warm Luna NONE escalates to Astra and preserves the verified model/provider/tier', async t => {
  const { runAdaptiveRoute } = await subject(), calls = [], base = adapters(calls), now = 2000000;
  const config = { estimates: { luna: { expectedCostUsd: 0.0001, expectedLatencyMs: 1, cacheObservedAt: now } } };
  const result = await runAdaptiveRoute(input(), { stateDir: await temp(t), apiKeys: keys, config, now: () => now, ...base,
    runStructuredRequest: async (request, options) => ({ ...await base.runStructuredRequest(request, options),
      value: { routeId: request.model === 'openai/gpt-6-luna' ? 'NONE' : 'draft' },
      observedModel: request.model === 'openai/gpt-6-astra' ? 'openai/gpt-6-astra-20260903' : request.model,
      observedProvider: 'OpenAI', observedServiceTier: 'default' }),
  });
  assert.deepEqual(calls, ['openai/gpt-6-luna', 'openai/gpt-6-astra']); assert.equal(result.status, 'selected');
  assert.equal(result.attempts[1].observedModel, 'openai/gpt-6-astra-20260903');
  assert.equal(result.attempts[1].observedProvider, 'OpenAI'); assert.equal(result.attempts[1].observedServiceTier, 'default');
});

test('malformed stored billing is rejected rather than replayed into stdout', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t);
  await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...adapters() });
  const path = join(stateDir, 'adaptive-state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  const key = Object.keys(state.jobs)[0]; state.jobs[key].result.cost.estimatedProviderUsd = 'private-corrupt-cost';
  await writeFile(path, JSON.stringify(state));
  const replay = await runAdaptiveRoute(input(), { stateDir, fetchImpl: noCall });
  assert.equal(replay.reason, 'STATE_INVALID'); assert.ok(!JSON.stringify(replay).includes('private-corrupt-cost'));
});

test('real JEV and structured Luna adapters share policy and preserve billing using mocked HTTP', async t => {
  const { runAdaptiveRoute } = await subject(); const policies = [];
  for (const strategy of ['jev', 'luna']) {
    let calls = 0;
    const result = await runAdaptiveRoute(input(), { stateDir: await temp(t), apiKeys: keys, config: { strategy },
      fetchImpl: async (url, options) => {
        calls++; const body = JSON.parse(options.body);
        if (url === 'https://api.typesafe.ai/v1/systemone') {
          const question = body.questions.t0; policies.push(question.instructions.slice(question.instructions.indexOf('Choose the single available route')));
          return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers: { t0: {
            type: 'choice', choice: 'publish', confidence: 0.99, probabilities: { draft: 0, publish: 1, NONE: 0 },
          } } });
        }
        assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(body.model, 'openai/gpt-6-luna');
        policies.push(typeof body.messages[0].content === 'string' ? body.messages[0].content : body.messages[0].content.map(part => part.text).join(''));
        return Response.json({ model: 'openai/gpt-6-luna', provider: 'OpenAI', service_tier: 'default', choices: [{ finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ routeId: 'publish' }),
        } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 },
          cost: 0.001, is_byok: false } });
      },
    });
    assert.equal(result.status, 'selected'); assert.equal(result.requiresHostApproval, true); assert.equal(calls, 1);
    assert.equal(result.requests, 1); assert.equal(result.cost.complete, true); assert.equal(result.executionClaimed, false);
  }
  assert.ok(policies[1].includes(policies[0]));
});

test('concurrent invocation cannot dispatch while the first pending reservation owns the lock', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), base = adapters();
  let release, observed;
  const waiting = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { observed = resolve; });
  const first = runAdaptiveRoute(input(), { stateDir, apiKeys: keys, ...base, fetchImpl: async () => {
    const state = JSON.parse(await readFile(join(stateDir, 'adaptive-state.json'), 'utf8'));
    assert.equal(Object.values(state.jobs)[0].state, 'pending'); observed(); await waiting; return Response.json({});
  } });
  await dispatched;
  const second = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, fetchImpl: noCall });
  assert.equal(second.reason, 'STATE_LOCKED'); release(); assert.equal((await first).status, 'selected');
});

test('future completed timestamp fails closed instead of charging again after clock rollback', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), now = () => 1000000;
  await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now, ...adapters() });
  const path = join(stateDir, 'adaptive-state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  Object.values(state.jobs)[0].updatedAt += 1; await writeFile(path, JSON.stringify(state));
  const replay = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now, ...adapters(), fetchImpl: noCall });
  assert.equal(replay.status, 'needs_host'); assert.equal(replay.reason, 'STATE_INVALID'); assert.equal(replay.requests, 0);
});

test('selected cached decisions require a matching successful final attempt with observed provider evidence', async t => {
  const { runAdaptiveRoute } = await subject();
  for (const mutate of [
    result => { result.attempts.at(-1).status = 'needs_host'; result.attempts.at(-1).reason = 'TIMEOUT'; result.attempts.at(-1).observedModel = null; },
    result => { result.attempts.at(-1).observedModel = null; },
    result => { result.attempts.at(-1).reason = 'LOW_CONFIDENCE'; },
    result => { result.routeId = 'publish'; },
    result => { result.attempts.at(-1).observedProvider = null; },
  ]) {
    const stateDir = await temp(t), config = { strategy: 'luna' };
    await runAdaptiveRoute(input(), { stateDir, config, apiKeys: keys, ...adapters() });
    const path = join(stateDir, 'adaptive-state.json'), state = JSON.parse(await readFile(path, 'utf8'));
    mutate(Object.values(state.jobs)[0].result); await writeFile(path, JSON.stringify(state));
    const replay = await runAdaptiveRoute(input(), { stateDir, config, fetchImpl: noCall });
    assert.equal(replay.reason, 'STATE_INVALID'); assert.equal(replay.cacheHit, false); assert.equal(replay.requests, 0);
  }
});

test('adaptive compares scoped measured JEV cost with warm Luna rather than the JEV default prior', async t => {
  const { runAdaptiveRoute } = await subject();
  for (const [lunaCost, lunaLatency, expected] of [[0.00017, 1000, 'jev'], [0.00001, 200, 'luna']]) {
    const stateDir = await temp(t), calls = [], base = adapters(calls); let time = 2000000;
    const injected = { ...base,
      decideRouteBatch: async (value, options) => ({ ...await base.decideRouteBatch(value, options),
        cost: { estimatedJevUsd: 0.00004, complete: true, inputTokens: 100, outputTokens: 0 } }),
      runStructuredRequest: async (request, options) => ({ ...await base.runStructuredRequest(request, options),
        usage: { inputTokens: 100, cachedInputTokens: 80 }, cost: { reportedProviderUsd: lunaCost, complete: true, isByok: false } }),
    };
    for (const strategy of ['jev', 'luna']) await runAdaptiveRoute(input(), { stateDir, config: { strategy }, apiKeys: keys, now: () => time, ...injected });
    const path = join(stateDir, 'adaptive-state.json'), state = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.keys(state.jevObservations ?? {}).length, 1);
    const jev = Object.values(state.jevObservations)[0];
    assert.equal(jev.estimatedProviderUsd, 0.00004); assert.equal(jev.inputTokens, 100); assert.equal(jev.basis, 'provider_pricing_estimate');
    // Deterministic latency observations avoid a wall-clock-sensitive selector test.
    jev.latencyMs = 300; Object.values(state.observations)[0].latencyMs = lunaLatency;
    await writeFile(path, JSON.stringify(state));
    const adaptive = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now: () => time, ...injected });
    assert.equal(adaptive.selection.provider, expected); assert.equal(adaptive.selection.estimatesSource, 'local_provider_observation');
    assert.equal(adaptive.selection.expectedCostUsd, expected === 'jev' ? 0.00004 : lunaCost);
    assert.equal(adaptive.selection.estimateBasis, expected === 'jev' ? 'provider_pricing_estimate' : 'provider_reported_credit_charge');
    assert.equal(adaptive.requests, 1); assert.equal(calls.length, 3);
    time += 300001;
    const expired = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now: () => time, ...injected });
    assert.equal(expired.selection.provider, 'jev'); assert.equal(expired.selection.estimatesSource, 'configured_defaults');
    assert.equal(expired.selection.expectedCostUsd, 0.005); assert.equal(expired.requests, 1);
  }
});

test('host JEV estimates override observed JEV values while future, foreign-scope and ineligible observations are ignored', async t => {
  const { runAdaptiveRoute } = await subject(), stateDir = await temp(t), now = () => 2000000, base = adapters();
  const injected = { ...base, decideRouteBatch: async (value, options) => ({ ...await base.decideRouteBatch(value, options),
    cost: { estimatedJevUsd: 0.00004, complete: true, inputTokens: 100, outputTokens: 0 } }) };
  await runAdaptiveRoute(input(), { stateDir, config: { strategy: 'jev' }, apiKeys: keys, now, ...injected });
  const host = await runAdaptiveRoute(input(), { stateDir, config: { estimates: { jev: { expectedCostUsd: 0.01 } } }, apiKeys: keys, now, ...injected });
  assert.equal(host.selection.expectedCostUsd, 0.01); assert.equal(host.selection.estimatesSource, 'trusted_host');
  const foreign = await runAdaptiveRoute(input(), { stateDir, config: { scope: 'other' }, apiKeys: keys, now, ...injected });
  assert.equal(foreign.selection.expectedCostUsd, 0.005); assert.equal(foreign.selection.estimatesSource, 'configured_defaults');
  const path = join(stateDir, 'adaptive-state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  for (const observed of Object.values(state.jevObservations)) observed.observedAt = now() + 1;
  await writeFile(path, JSON.stringify(state));
  const future = await runAdaptiveRoute(input(), { stateDir, apiKeys: keys, now, ...injected });
  assert.equal(future.selection.expectedCostUsd, 0.005); assert.equal(future.selection.estimatesSource, 'configured_defaults');
  const noJev = await runAdaptiveRoute(input(), { stateDir, config: { estimates: {
    jev: { qualityEligible: false }, luna: { qualityEligible: true, expectedCostUsd: 0.1, cacheObservedAt: now() },
  } }, apiKeys: keys, now, ...injected });
  assert.equal(noJev.selection.provider, 'luna');
});

test('offline unresolved Luna eligibility can resolve only from fresh matching local observations', async t => {
  const { prepareAdaptiveRoute, runAdaptiveRoute } = await subject(), stateDir = await temp(t), now = () => 2000000;
  const config = { estimates: { jev: { qualityEligible: false }, luna: { qualityEligible: true } } };
  const offline = prepareAdaptiveRoute(input(), { config, now });
  assert.equal(offline.status, 'preflight'); assert.equal(offline.selection, null); assert.equal(offline.requiresObservation, true);
  const absent = await runAdaptiveRoute(input(), { config, stateDir, now, fetchImpl: noCall });
  assert.equal(absent.reason, 'NO_ELIGIBLE_PROVIDER'); assert.equal(absent.requests, 0);
  const base = adapters(), observed = { ...base, runStructuredRequest: async (request, options) => ({
    ...await base.runStructuredRequest(request, options), usage: { inputTokens: 100, cachedInputTokens: 80 },
    cost: { reportedProviderUsd: 0.0001, complete: true, isByok: false },
  }) };
  await runAdaptiveRoute(input(), { stateDir, config: { strategy: 'luna' }, apiKeys: keys, now, ...observed });
  const resolved = await runAdaptiveRoute(input(), { config, stateDir, apiKeys: keys, now, ...observed });
  assert.equal(resolved.status, 'selected'); assert.equal(resolved.selection.provider, 'luna');
  assert.equal(resolved.selection.estimatesSource, 'local_provider_observation'); assert.equal(resolved.requests, 1);
  const noEligible = prepareAdaptiveRoute(input(), { config: { estimates: {
    jev: { qualityEligible: false }, luna: { qualityEligible: false },
  } }, now });
  assert.equal(noEligible.status, 'needs_host'); assert.equal(noEligible.reason, 'NO_ELIGIBLE_PROVIDER');
  const foreign = await runAdaptiveRoute(input(), { config: { ...config, scope: 'other' }, stateDir, now, fetchImpl: noCall });
  assert.equal(foreign.reason, 'NO_ELIGIBLE_PROVIDER'); assert.equal(foreign.requests, 0);
  const stale = await runAdaptiveRoute(input(), { config, stateDir, now: () => now() + 300001, fetchImpl: noCall });
  assert.equal(stale.reason, 'NO_ELIGIBLE_PROVIDER'); assert.equal(stale.requests, 0);
});
