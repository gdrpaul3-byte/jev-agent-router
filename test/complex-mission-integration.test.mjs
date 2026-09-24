import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { buildMissionCases } from '../benchmarks/complex-mission-cases.mjs';
import { evaluateComplexMissions } from '../benchmarks/complex-mission-eval.mjs';

const ORIGIN = 'https://openrouter.ai/api/v1/chat/completions';
const JEV = 'https://api.typesafe.ai/v1/systemone';
const POSITIVE_ROUTES = ['r1', 'r2', 'r3'];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

async function cases() {
  return buildMissionCases(JSON.parse(await readFile(new URL('../benchmarks/complex-missions.json', import.meta.url), 'utf8')));
}

async function withState(run) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'jev-complex-integration-'));
  try { return await run(directory); }
  finally {
    // Check the resolved Windows target before recursively deleting test state.
    const target = resolve(directory);
    assert.ok(target.startsWith(parent + sep)); assert.ok(basename(target).startsWith('jev-complex-integration-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function mockHttp(frozenCases) {
  const calls = [], seenPrefixes = new Set();
  // The answer lookup exists ONLY inside this test transport. The real runners get
  // the production fixture builder's request/evidence and never receive this map.
  const answers = new Map(frozenCases.map(item => [JSON.stringify([item.mission.input.request,
    POSITIVE_ROUTES.map(routeId => item.toolOutputs[routeId])]), item.expected.output]));
  const choose = ids => {
    const selected = ids.filter(routeId => POSITIVE_ROUTES.includes(routeId));
    assert.equal(selected.length, 1); return selected[0];
  };
  const fetchImpl = async (url, init) => {
    assert.ok([ORIGIN, JEV].includes(url)); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.headers.Authorization, 'Bearer test');
    const body = JSON.parse(init.body);
    for (const field of ['"expected"', '"variant"', '"humanValidated"', '"label"']) assert.ok(!init.body.includes(field), `${field} reached the model`);
    if (url === JEV) {
      assert.equal(body.model, 'jev-1.13.0');
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const ids = Object.keys(question.criteria), selected = choose(ids);
        return [id, { type: 'choice', choice: selected, confidence: 1,
          probabilities: Object.fromEntries(ids.map(routeId => [routeId, routeId === selected ? 1 : 0])) }];
      }));
      calls.push({ model: body.model, kind: 'routing', inputTokens: 1000, expectedEstimateUsd: .000042, reportedUsd: null, cachedTokens: null });
      return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 }, answers });
    }
    assert.ok(['openai/gpt-6-luna', 'openai/gpt-6-astra'].includes(body.model));
    assert.deepEqual(body.provider, { only: ['openai'], ignore: ['openai/flex', 'openai/fast'], allow_fallbacks: false, require_parameters: true });
    assert.equal(body.service_tier, 'default'); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
    const content = body.messages[1].content, prefix = content[0], input = JSON.parse(content[1].text);
    assert.deepEqual(prefix.prompt_cache_breakpoint, { mode: 'explicit' });
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.equal(body.response_format.json_schema.strict, true);
    const properties = body.response_format.json_schema.schema.properties;
    const routing = Object.hasOwn(properties, 'routeId');
    let output;
    if (routing) {
      assert.ok(/^t[0-2]$/.test(input.id));
      output = { routeId: choose(properties.routeId.enum) };
    } else {
      assert.equal(body.model, 'openai/gpt-6-astra'); assert.equal(input.evidence.length, 3);
      assert.deepEqual(input.routeDecisions.map(item => item.routeId), POSITIVE_ROUTES);
      output = answers.get(JSON.stringify([input.request, input.evidence]));
      assert.ok(output, 'Synthesis must use an actual fixture request and its current selected evidence');
    }
    const prefixKey = JSON.stringify([body.model, body.prompt_cache_key, body.messages[0], prefix, body.response_format]);
    const cachedTokens = seenPrefixes.has(prefixKey) ? 600 : 0; seenPrefixes.add(prefixKey);
    const reportedUsd = routing ? body.model === 'openai/gpt-6-astra' ? .002 : .0001 : .006;
    calls.push({ model: body.model, kind: routing ? 'routing' : 'synthesis', inputTokens: 1000, expectedEstimateUsd: null, reportedUsd, cachedTokens });
    return Response.json({ model: body.model === 'openai/gpt-6-astra' ? 'openai/gpt-6-astra-20260903' : 'openai/gpt-6-luna-20260922',
      provider: 'OpenAI', service_tier: 'default', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cachedTokens ? 0 : 600 },
        completion_tokens_details: { reasoning_tokens: body.model === 'openai/gpt-6-astra' ? 20 : 0 },
        cost: reportedUsd, is_byok: false, cost_details: { upstream_inference_cost: reportedUsd } } });
  };
  return { fetchImpl, calls };
}

test('real fixture, adaptive router, structured adapter and budget complete 18 mocked workflows with exact replay and changed evidence', async () => {
  const frozenCases = await cases(); const transport = mockHttp(frozenCases);
  await withState(async stateDir => {
    const report = await evaluateComplexMissions(frozenCases, { stateDir, apiKeys: { typesafe: 'test', openrouter: 'test' },
      fetchImpl: transport.fetchImpl, budgetUsd: 5, maxRequests: 80 });
    assert.equal(report.status, 'complete'); assert.equal(report.runs.length, 18); assert.equal(report.accounting.complete, true);
    assert.equal(report.accounting.blockedReason, null);
    assert.ok(report.runs.every(run => run.status === 'produced' && run.quality.passed));
    assert.ok(report.runs.every(run => run.routeQuality.correct === 3 && run.routeQuality.total === 3));
    for (const arm of ['astra', 'luna', 'adaptive']) {
      const runs = report.runs.filter(run => run.arm === arm);
      assert.equal(runs.length, 6); assert.equal(runs.filter(run => run.cacheHit).length, 2);
      for (const missionId of ['m1', 'm2']) {
        const base = runs.find(run => run.missionId === missionId && run.phase === 'base');
        const changed = runs.find(run => run.missionId === missionId && run.phase === 'changed');
        const replay = runs.find(run => run.missionId === missionId && run.phase === 'exact_repeat');
        assert.equal(base.requests, 4); assert.equal(changed.requests, 2);
        assert.equal(changed.cacheHit, false); assert.notEqual(base.fingerprint, changed.fingerprint);
        assert.deepEqual(changed.routing.map(route => route.cacheHit), [true, false, true]);
        assert.deepEqual(base.artifact, frozenCases.find(item => item.id === missionId && item.variant === 'base').expected.output);
        assert.deepEqual(changed.artifact, frozenCases.find(item => item.id === missionId && item.variant === 'changed').expected.output);
        assert.notDeepEqual(base.artifact, changed.artifact);
        assert.equal(replay.cacheHit, true); assert.equal(replay.requests, 0); assert.deepEqual(replay.requestIndices, []);
        assert.equal(replay.cost.accountedProviderUsd, 0); assert.equal(replay.reusedRunIndex, base.index);
        assert.deepEqual(replay.artifact, base.artifact); assert.equal(replay.fingerprint, base.fingerprint);
        assert.ok(changed.synthesis.usage.cachedInputTokens > 0); assert.equal(base.synthesis.usage.cachedInputTokens, 0);
      }
    }
    assert.equal(transport.calls.length, 36); assert.equal(report.accounting.requests, 36); assert.equal(report.requests.length, 36);
    assert.equal(report.runs.reduce((sum, run) => sum + run.requests, 0), 36);
    assert.deepEqual(report.runs.flatMap(run => run.requestIndices).sort((a, b) => a - b), Array.from({ length: 36 }, (_, index) => index + 1));
    assert.equal(transport.calls.filter(call => call.model === 'jev-1.13.0').length, 8);
    assert.equal(transport.calls.filter(call => call.model === 'openai/gpt-6-luna').length, 8);
    assert.equal(transport.calls.filter(call => call.model === 'openai/gpt-6-astra').length, 20);
    assert.equal(transport.calls.filter(call => call.kind === 'synthesis').length, 12);
    const reported = transport.calls.reduce((sum, call) => sum + (call.reportedUsd ?? 0), 0);
    const estimated = transport.calls.reduce((sum, call) => sum + (call.expectedEstimateUsd ?? 0), 0);
    close(report.accounting.reportedProviderUsd, reported); close(report.accounting.estimatedProviderUsd, estimated);
    close(report.accounting.accountedProviderUsd, reported + estimated);
    close(report.runs.reduce((sum, run) => sum + run.cost.accountedProviderUsd, 0), reported + estimated);
    for (const [index, row] of report.requests.entries()) {
      assert.equal(row.index, index + 1); assert.equal(row.model, transport.calls[index].model); assert.equal(row.httpStatus, 200);
      assert.equal(row.costComplete, true); assert.equal(row.reportedProviderUsd, transport.calls[index].reportedUsd);
      assert.equal(row.estimatedProviderUsd, transport.calls[index].expectedEstimateUsd);
    }
    assert.ok(!JSON.stringify(report).includes('Bearer test'));
  });
});

test('real dispatch stack stops at the global request cap without an unmetered sixth request', async () => {
  const frozenCases = await cases(); const transport = mockHttp(frozenCases);
  await withState(async stateDir => {
    const report = await evaluateComplexMissions(frozenCases, { stateDir, apiKeys: { typesafe: 'test', openrouter: 'test' },
      fetchImpl: transport.fetchImpl, budgetUsd: 5, maxRequests: 5 });
    assert.equal(report.status, 'stopped'); assert.equal(report.accounting.blockedReason, 'CALL_BUDGET_EXHAUSTED');
    assert.equal(transport.calls.length, 5); assert.equal(report.accounting.requests, 5); assert.equal(report.requests.length, 5);
    assert.equal(report.runs.length, 2); assert.equal(report.runs[0].status, 'produced'); assert.equal(report.runs[0].requests, 4);
    assert.equal(report.runs[1].status, 'routing_failed'); assert.equal(report.runs[1].requests, 1); assert.equal(report.runs[1].quality.passed, false);
    assert.equal(transport.calls.filter(call => call.kind === 'synthesis').length, 1);
    assert.equal(report.accounting.complete, true);
    close(report.accounting.accountedProviderUsd, transport.calls.reduce((sum, call) => sum + (call.reportedUsd ?? 0) + (call.expectedEstimateUsd ?? 0), 0));
  });
});
