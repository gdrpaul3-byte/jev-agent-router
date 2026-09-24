import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';

async function subject() {
  let module;
  try { module = await import('../benchmarks/llm-control-eval.mjs'); }
  catch { assert.fail('The matched LLM control evaluator must exist'); }
  return module;
}
const fixture = () => ({ schemaVersion: 1, synthetic: true, cases: [
  { id: 'label-draft', expected: { routeId: 'draft', requiresHostApproval: false } },
  { id: 'label-no-safe-route', expected: { needsHost: true } },
] });
const packet = () => ({ tasks: ['t0', 't1'].map(id => ({ id, task: { id, revision: 1, request: 'private-request-body', progress: '',
  evidence: [{ id: 'e0', text: 'private-evidence-body' }] }, routes: [
  { id: 'draft', description: 'Create an internal draft', kind: 'draft', requiresApproval: false },
  { id: 'publish', description: 'Publish externally', kind: 'write', requiresApproval: true },
], policy: 'Choose a permitted route or NONE. Do not execute anything.' })) });
function preparation(input) {
  const value = packet();
  return { packet: value, inputs: [], scoring: input.cases.map((item, index) => ({ opaqueId: `t${index}`, originalCaseId: item.id, expected: item.expected })),
    datasetSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    packetSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
const decision = (id, routeId = 'draft', requiresHostApproval = false) => ({ id, outcome: 'accepted', routeId, requiresHostApproval, reason: null });
const abstention = id => ({ id, outcome: 'abstained', routeId: null, requiresHostApproval: null, reason: 'NO_SAFE_ROUTE' });
const cost = () => ({ estimatedProviderUsd: 0.001, knownUsageUsd: 0.001, cashChargeUsd: null, complete: true,
  pricingSource: 'https://docs.typesafe.ai/models', pricingVerifiedOn: '2026-09-24' });
function deps(order = [], packets = []) {
  const run = name => async (value, options) => {
    order.push(name); packets.push(structuredClone(value));
    await options.fetchImpl(name === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.openai.com/v1/responses', { method: 'POST' });
    return { decisions: [decision('t0'), abstention('t1')], requestedModel: name === 'jev' ? 'jev-1.13.0' : 'gpt-6-luna',
      observedModel: name === 'jev' ? 'jev-1.13.0' : 'gpt-6-luna', wallLatencyMs: 1, requests: 1,
      usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, cost: cost() };
  };
  return {
    prepareComparisonCases: preparation,
    prepareJevControlRequest: async () => ({ status: 'prepared', requestBytes: 200, requestedModel: 'jev-1.13.0' }),
    prepareOpenAiControlRequest: () => ({ status: 'prepared', body: 'private-body', requestBytes: 250, requestedModel: 'gpt-6-luna' }),
    runJevControl: run('jev'), runOpenAiControl: run('openai'), fetchImpl: async () => new Response('{}'),
  };
}
const keys = () => ({ typesafe: 'private-typesafe-secret', openai: 'private-openai-secret' });
const noCall = () => assert.fail('This path must not call an adapter or transport');
async function temporary(t) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, 'jev-llm-control-'));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(parent + sep) && basename(dir).startsWith('jev-llm-control-'));
    // Windows scanners can briefly hold a handle after a completed atomic rename.
    return rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const input = join(dir, 'cases.json'), output = join(dir, 'report.json');
  await writeFile(input, JSON.stringify(fixture()));
  return { dir, input, output };
}

test('two rounds run AB/BA with the identical anonymous packet and at most four POSTs', async () => {
  const order = [], packets = []; let calls = 0;
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...deps(order, packets), apiKeys: keys(),
    fetchImpl: async (_, options) => { calls++; assert.equal(options.method, 'POST'); return new Response('{}'); } });
  assert.deepEqual(order, ['jev', 'openai', 'openai', 'jev']); assert.equal(calls, 4);
  assert.equal(report.status, 'complete'); assert.equal(report.metrics.requests, 4);
  assert.deepEqual(report.rounds.map(round => round.order), [['jev', 'openai'], ['openai', 'jev']]);
  for (const value of packets) assert.deepEqual(value, packet());
  assert.ok(!JSON.stringify(packets).includes('label-draft')); assert.ok(!JSON.stringify(packets).includes('label-no-safe-route'));
  for (const round of report.rounds) {
    assert.deepEqual(round.disagreementIds, []);
    for (const arm of round.arms) {
      assert.equal(arm.metrics.routing.coverage, 1); assert.equal(arm.metrics.routing.acceptedAccuracy, 1);
      assert.equal(arm.metrics.expectedHost.correctness, 1); assert.equal(arm.metrics.wrongAcceptances, 0);
    }
  }
  const text = JSON.stringify(report);
  for (const secret of [...Object.values(keys()), 'private-request-body', 'private-evidence-body', 'private-body']) assert.ok(!text.includes(secret));
});

test('both credentials are validated before either paid arm', async () => {
  const { evaluateLlmControl } = await subject();
  for (const apiKeys of [{ typesafe: 'test' }, { openai: 'test' }, {}, { typesafe: 'test', openai: 'bad\nkey' },
    { typesafe: 'test', openai: 'bad\u0000key' }, { typesafe: 'test', openai: 'x'.repeat(4097) }]) {
    await assert.rejects(evaluateLlmControl(fixture(), { ...deps(), apiKeys, runJevControl: noCall, runOpenAiControl: noCall, fetchImpl: noCall }), /MISSING_|INVALID_CREDENTIALS/);
  }
});

test('one arm cannot mutate the packet seen by another arm', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runJevControl: async (value, options) => {
      value.tasks[0].task.request = 'changed'; return injected.runJevControl(value, options);
    },
    runOpenAiControl: async (value, options) => { assert.equal(value.tasks[0].task.request, 'private-request-body'); return injected.runOpenAiControl(value, options); },
  });
  assert.equal(report.status, 'complete');
});

test('wrong approval acceptance is incorrect and provider errors never become correct abstentions', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runOpenAiControl: async (value, options) => ({ ...await injected.runOpenAiControl(value, options),
      decisions: [decision('t0', 'draft', true), { ...abstention('t1'), outcome: 'error', reason: 'HTTP_ERROR' }] }),
  });
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.metrics.routing.acceptedAccuracy, 0); assert.equal(arm.metrics.expectedHost.correctAbstentions, 0);
  assert.equal(arm.metrics.outcomes.errors, 1); assert.equal(arm.metrics.wrongAcceptances, 1);
  assert.deepEqual(report.rounds[0].disagreementIds, ['label-draft', 'label-no-safe-route']);
  assert.equal(report.rounds[0].comparison.bothErrorFree, false);
  assert.equal(report.measurement.speedupClaimed, false);
});

test('requests and costs from failed arms are preserved without inventing unknown usage', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runOpenAiControl: async (value, options) => ({ ...await injected.runOpenAiControl(value, options),
      decisions: value.tasks.map(task => ({ ...abstention(task.id), outcome: 'error', reason: 'TIMEOUT' })),
      usage: { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null },
      cost: { ...cost(), estimatedProviderUsd: null, knownUsageUsd: 0, complete: false } }),
  });
  assert.equal(report.metrics.requests, 2); assert.equal(report.metrics.cost.estimatedProviderUsd, null);
  assert.equal(report.metrics.cost.knownUsageUsd, 0.001); assert.equal(report.metrics.cost.unknownArms, 1);
  const usage = report.rounds[0].arms[1].usage;
  assert.equal(usage.inputTokens, null); assert.equal(usage.cacheWriteInputTokens, null);
});

test('duplicate/missing IDs fail the arm rather than shifting scores onto different labels', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runJevControl: async (value, options) => ({ ...await injected.runJevControl(value, options), decisions: [decision('t0'), decision('t0')] }),
  });
  assert.equal(report.rounds[0].arms[0].aggregateError, 'INVALID_ADAPTER_RESULT');
  assert.equal(report.rounds[0].arms[0].metrics.outcomes.errors, 2);
});

test('arm latency excludes checkpoint I/O and each completed arm is checkpointed before the next POST', async () => {
  const order = [], snapshots = [];
  const started = performance.now();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...deps(order), apiKeys: keys(), rounds: 1,
    onProgress: async value => { snapshots.push(structuredClone(value)); await new Promise(resolve => setTimeout(resolve, 40)); },
  });
  const elapsed = performance.now() - started;
  assert.ok(snapshots.some(value => value.metrics.requests === 1 && value.rounds[0].arms.length === 1));
  assert.ok(elapsed - report.rounds[0].arms.reduce((sum, arm) => sum + arm.processingLatencyMs, 0) >= 100);
  let calls = 0;
  await assert.rejects((await subject()).evaluateLlmControl(fixture(), { ...deps(), apiKeys: keys(),
    fetchImpl: async () => { calls++; return new Response('{}'); }, onProgress: () => { throw new Error('checkpoint failed'); },
  }), /checkpoint failed/);
  assert.equal(calls, 1);
});

test('a broken adapter cannot cause more than one request per arm or four requests overall', async () => {
  const injected = deps(); let calls = 0;
  const malicious = async (_, options) => {
    for (let index = 0; index < 5; index++) await options.fetchImpl('https://api.openai.com/v1/responses', { method: 'POST' });
    throw new Error('unexpected');
  };
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(),
    runJevControl: malicious, runOpenAiControl: malicious, fetchImpl: async () => { calls++; return new Response('{}'); } });
  assert.equal(calls, 4); assert.equal(report.metrics.requests, 4);
  assert.equal(report.metrics.cost.estimatedProviderUsd, null);
});

test('sanitized reports retain cache/output billing but never print raw provider diagnostics', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runOpenAiControl: async (value, options) => ({ ...await injected.runOpenAiControl(value, options), observedModel: 'C:/private-path',
      diagnostics: 'private-secret', cost: { ...cost(), pricingSource: 'https://evil.test/private-secret', raw: 'private-secret' },
      usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 2, key: 'private-secret' },
    }),
  });
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.usage.cacheWriteInputTokens, 30); assert.equal(arm.usage.reasoningOutputTokens, 2);
  const text = JSON.stringify(report);
  for (const word of ['private-path', 'private-secret', 'evil.test']) assert.ok(!text.includes(word));
});

test('strict options reject unknown models, more than two rounds and unexpected fields', async () => {
  const { evaluateLlmControl } = await subject();
  for (const options of [{ rounds: 0 }, { rounds: 3 }, { model: 'other-model' }, { surprising: true }]) {
    await assert.rejects(evaluateLlmControl(fixture(), { ...deps(), apiKeys: keys(), fetchImpl: noCall, ...options }));
  }
});

test('offline preflight emits hashes/limits without reading credentials, calling adapters or creating output', async t => {
  const f = await temporary(t), injected = deps();
  const env = new Proxy({}, { get() { assert.fail('offline preflight must not inspect env credentials'); } });
  const output = await (await subject()).runLlmControlEvaluationCli(['--preflight', '--cases', f.input, '--rounds', '2'], {
    ...injected, env, fetchImpl: noCall, runJevControl: noCall, runOpenAiControl: noCall,
  });
  assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'preflight');
  assert.equal(output.result.plannedRequests, 4); assert.match(output.result.packetSha256, /^[a-f0-9]{64}$/);
  assert.equal(output.result.limits.timeoutMs, 60000);
  for (const word of ['private-request-body', 'private-evidence-body', 'private-body', f.dir]) assert.ok(!JSON.stringify(output).includes(word));
});

test('missing either credential exits two with zero POSTs before any paid arm', async t => {
  const f = await temporary(t), { runLlmControlEvaluationCli } = await subject();
  for (const [env, reason] of [[{ TYPESAFE_API_KEY: 'test' }, 'MISSING_OPENAI_API_KEY'], [{ OPENAI_API_KEY: 'test' }, 'MISSING_TYPESAFE_API_KEY']]) {
    const output = await runLlmControlEvaluationCli(['--live', '--cases', f.input, '--output', f.output], {
      ...deps(), env, fetchImpl: noCall, runJevControl: noCall, runOpenAiControl: noCall,
    });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, reason);
  }
});

test('explicit env files support both keys, env takes precedence, and output checkpoints are private', async t => {
  const f = await temporary(t), file = join(f.dir, 'private.env');
  await writeFile(file, 'OPENAI_API_KEY=private-openai-file\nTYPESAFE_API_KEY=private-typesafe-file\n');
  const injected = deps();
  const output = await (await subject()).runLlmControlEvaluationCli(['--live', '--cases', f.input, '--output', f.output,
    '--env-file', file, '--rounds', '1', '--model', 'gpt-6-luna'], { ...injected, env: { OPENAI_API_KEY: 'private-openai-env' },
    runJevControl: (value, options) => { assert.equal(options.apiKey, 'private-typesafe-file'); return injected.runJevControl(value, options); },
    runOpenAiControl: (value, options) => { assert.equal(options.apiKey, 'private-openai-env'); return injected.runOpenAiControl(value, options); },
  });
  assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'complete');
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.status, 'complete'); assert.equal(report.rounds[0].arms.length, 2);
  for (const secret of ['private-openai-file', 'private-typesafe-file', 'private-openai-env', 'private-request-body', f.dir]) assert.ok(!JSON.stringify([output, report]).includes(secret));
});

test('CLI refuses existing output and malformed/oversized data without any paid request', async t => {
  const f = await temporary(t), { runLlmControlEvaluationCli } = await subject();
  await writeFile(f.output, 'preserve');
  const output = await runLlmControlEvaluationCli(['--live', '--cases', f.input, '--output', f.output], {
    ...deps(), env: { TYPESAFE_API_KEY: 'test', OPENAI_API_KEY: 'test' }, fetchImpl: noCall,
  });
  assert.equal(output.result.reason, 'OUTPUT_EXISTS'); assert.equal(await readFile(f.output, 'utf8'), 'preserve');
  for (const body of ['private-broken-json', ' '.repeat(1000001)]) {
    await writeFile(f.input, body);
    const result = await runLlmControlEvaluationCli(['--preflight', '--cases', f.input], { ...deps(), fetchImpl: noCall });
    assert.equal(result.exitCode, 2); assert.equal(result.result.reason, body.length > 1000000 ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES');
  }
});

test('CLI requires exactly one execution mode and strict known options', async () => {
  const { runLlmControlEvaluationCli } = await subject();
  for (const argv of [[], ['--live'], ['--output', 'report.json'], ['--live', '--preflight', '--output', 'x'],
    ['--preflight', '--env-file', '.env'], ['--preflight', '--output', 'x'], ['--preflight', '--rounds', '3'],
    ['--preflight', '--model', 'gpt-other'], ['--preflight', '--rounds'], ['--preflight', '--preflight'],
    ['--preflight', '--unknown', 'x'], ['--help', '--live']]) {
    const result = await runLlmControlEvaluationCli(argv, { ...deps(), fetchImpl: noCall });
    assert.equal(result.exitCode, 2); assert.equal(result.result.reason, 'INVALID_ARGUMENTS');
  }
});

test('both paid arms receive the same sixty-second deadline for full control completion', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runJevControl: (value, options) => { assert.equal(options.timeoutMs, 60000); return injected.runJevControl(value, options); },
    runOpenAiControl: (value, options) => { assert.equal(options.timeoutMs, 60000); return injected.runOpenAiControl(value, options); },
  });
  assert.equal(report.metrics.outcomes.errors, 0);
});

test('CLI does not claim unknown or real fixture provenance is synthetic', async t => {
  const f = await temporary(t);
  for (const value of [{ ...fixture(), synthetic: false }, { ...fixture(), schemaVersion: 2 }, { schemaVersion: 1, cases: fixture().cases }]) {
    await writeFile(f.input, JSON.stringify(value));
    const result = await (await subject()).runLlmControlEvaluationCli(['--preflight', '--cases', f.input], { ...deps(), fetchImpl: noCall });
    assert.equal(result.exitCode, 2); assert.equal(result.result.reason, 'INVALID_EVALUATION_CASES');
  }
});

test('a recognized fast service tier remains attached to its billed arm', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runOpenAiControl: async (value, options) => ({ ...await injected.runOpenAiControl(value, options), observedServiceTier: 'fast' }),
  });
  assert.equal(report.rounds[0].arms[1].observedServiceTier, 'fast');
});

test('real twelve-case projection and both production adapters interoperate through the CLI with mocked HTTP', async t => {
  const f = await temporary(t), actual = JSON.parse(await readFile(new URL('../benchmarks/news-triage-cases.json', import.meta.url), 'utf8'));
  const { runLlmControlEvaluationCli } = await subject();
  const offline = await runLlmControlEvaluationCli(['--preflight'], {
    env: new Proxy({}, { get: noCall }), fetchImpl: noCall,
  });
  assert.equal(offline.exitCode, 0); assert.equal(offline.result.caseCount, 12); assert.equal(offline.result.plannedRequests, 4);
  let calls = 0;
  const output = await runLlmControlEvaluationCli(['--live', '--output', f.output, '--rounds', '1'], {
    env: { TYPESAFE_API_KEY: 'fake-typesafe', OPENAI_API_KEY: 'fake-openai' },
    fetchImpl: async (url, options) => {
      calls++; assert.equal(options.method, 'POST'); const body = JSON.parse(options.body);
      for (const item of actual.cases) {
        assert.ok(!options.body.includes(item.id)); assert.ok(!options.body.includes(item.input.task.id));
      }
      const choice = index => actual.cases[index].expected.needsHost ? 'NONE' : actual.cases[index].expected.routeId;
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        assert.equal(body.model, 'jev-1.13.0');
        const answers = {};
        for (const [key, question] of Object.entries(body.questions)) {
          const selected = choice(Number(key.slice(1)));
          answers[key] = { type: 'choice', choice: selected, confidence: 0.99,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected ? 1 : 0])) };
        }
        return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers });
      }
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.deepEqual(body.reasoning, { effort: 'none' }); assert.equal(body.service_tier, 'default');
      const packet = JSON.parse(body.input[0].content);
      for (const [index, task] of packet.tasks.entries()) {
        assert.equal(task.id, `t${index}`); assert.equal(task.task.id, task.id); assert.equal(task.task.revision, 1);
        task.task.evidence.forEach((evidence, index) => assert.equal(evidence.id, `e${index}`));
      }
      return Response.json({ model: 'gpt-6-luna', service_tier: 'default', status: 'completed', error: null, tools: [], tool_choice: 'none',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ decisions: packet.tasks.map((task, index) => ({ id: task.id, routeId: choice(index) })) }) }] }],
        usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 230 },
      });
    },
  });
  assert.equal(calls, 2); assert.equal(output.exitCode, 0);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.metrics.requests, 2); assert.equal(report.metrics.cost.unknownArms, 1);
  assert.equal(report.metrics.cost.estimatedProviderUsd, null);
  assert.deepEqual(report.rounds[0].disagreementIds, []);
  for (const arm of report.rounds[0].arms) {
    assert.equal(arm.rows.length, 12); assert.equal(arm.metrics.routing.acceptedAccuracy, 1); assert.equal(arm.metrics.expectedHost.correctness, 1);
  }
  const openai = report.rounds[0].arms[1];
  assert.equal(openai.usage.cacheWriteInputTokens, null); assert.ok(openai.cost.knownUsageUsd > 0);
  assert.ok(!JSON.stringify(report).includes(actual.cases[0].input.task.request));
});

test('production OpenAI authentication diagnostics survive report sanitation without the raw error message', async () => {
  const actual = JSON.parse(await readFile(new URL('../benchmarks/news-triage-cases.json', import.meta.url), 'utf8'));
  const report = await (await subject()).evaluateLlmControl(actual, { apiKeys: keys(), rounds: 1,
    fetchImpl: async (url, options) => {
      if (url === 'https://api.openai.com/v1/responses') return Response.json({ error: {
        code: 'invalid_api_key', type: 'invalid_request_error', message: 'reflected-private-key-do-not-print',
      } }, { status: 401 });
      const request = JSON.parse(options.body), answers = {};
      for (const [key, question] of Object.entries(request.questions)) answers[key] = {
        type: 'choice', choice: 'NONE', confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === 'NONE' ? 1 : 0])),
      };
      return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers });
    },
  });
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.httpStatus, 401); assert.equal(arm.providerErrorCode, 'invalid_api_key');
  assert.equal(arm.providerErrorType, 'invalid_request_error'); assert.equal(arm.metrics.outcomes.errors, 12);
  assert.equal(arm.cost.estimatedProviderUsd, null); assert.equal(report.metrics.requests, 2);
  assert.ok(!JSON.stringify(report).includes('reflected-private-key-do-not-print'));
});

test('diagnostic fields reject out-of-range status and arbitrary reflected code/type strings', async () => {
  const injected = deps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, apiKeys: keys(), rounds: 1,
    runOpenAiControl: async (value, options) => ({ ...await injected.runOpenAiControl(value, options),
      httpStatus: 999, providerErrorCode: 'sk-private-reflected-code', providerErrorType: 'private-reflected-type',
      error: { message: 'private-reflected-message' } }),
  });
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.httpStatus, null); assert.equal(arm.providerErrorCode, null); assert.equal(arm.providerErrorType, null);
  for (const text of ['sk-private-reflected-code', 'private-reflected-type', 'private-reflected-message']) assert.ok(!JSON.stringify(report).includes(text));
});

function routerDeps(order = [], packets = []) {
  const injected = deps(order, packets);
  return { ...injected, prepareOpenAiControlRequest: noCall, runOpenAiControl: noCall,
    prepareOpenRouterControlRequest: (_, options) => {
      assert.equal(options.model, 'openai/gpt-6-luna'); assert.equal(options.timeoutMs, 60000);
      return { status: 'prepared', body: 'private-router-body', requestBytes: 300, requestedModel: options.model };
    },
    runOpenRouterControl: async (value, options) => {
      order.push('openrouter'); packets.push(structuredClone(value));
      assert.equal(options.apiKey, 'private-router-secret'); assert.equal(options.model, 'openai/gpt-6-luna');
      assert.equal(options.timeoutMs, 60000); assert.equal(options.maxOutputTokens, 2048);
      await options.fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      return { decisions: [decision('t0'), abstention('t1')], requestedModel: options.model,
        observedModel: 'openai/gpt-6-luna-20260922', observedProvider: 'OpenAI', requests: 1, wallLatencyMs: 1,
        httpStatus: 200, providerErrorCode: '401', providerErrorType: null,
        usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: null, outputTokens: 10, reasoningOutputTokens: 0 },
        cost: { estimatedProviderUsd: null, reportedProviderUsd: 0.002, upstreamInferenceCostUsd: 0.0015, isByok: false,
          knownUsageUsd: 0.002, complete: true, cashChargeUsd: null, basis: 'provider_reported_credit_charge',
          pricingSource: 'https://openrouter.ai/docs/cookbook/administration/usage-accounting' } };
    } };
}
const routerKeys = () => ({ typesafe: 'private-typesafe-secret', openrouter: 'private-router-secret' });

test('OpenRouter runs matching AB/BA packets and separates reported credits from estimated cost', async () => {
  const order = [], packets = [];
  const report = await (await subject()).evaluateLlmControl(fixture(), {
    ...routerDeps(order, packets), provider: 'openrouter', apiKeys: routerKeys(),
  });
  assert.equal(report.provider, 'openrouter'); assert.deepEqual(order, ['jev', 'openrouter', 'openrouter', 'jev']);
  assert.deepEqual(report.models, { jev: 'jev-1.13.0', openrouter: 'openai/gpt-6-luna' });
  assert.deepEqual(report.requestBytes, { jev: 200, openrouter: 300 });
  for (const value of packets) assert.deepEqual(value, packet());
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.observedModel, 'openai/gpt-6-luna-20260922'); assert.equal(arm.observedProvider, 'OpenAI');
  assert.equal(arm.providerErrorCode, '401'); assert.equal(arm.cost.estimatedProviderUsd, null);
  assert.equal(arm.cost.reportedProviderUsd, 0.002); assert.equal(arm.cost.upstreamInferenceCostUsd, 0.0015);
  assert.equal(arm.cost.isByok, false); assert.equal(arm.cost.billingScope, 'openrouter_account_credits');
  assert.equal(arm.cost.basis, 'provider_reported_credit_charge'); assert.equal(arm.cost.complete, true);
  assert.equal(report.metrics.cost.estimatedProviderUsd, 0.002); assert.equal(report.metrics.cost.reportedProviderUsd, 0.004);
  assert.equal(report.metrics.cost.accountedProviderUsd, 0.006); assert.equal(report.metrics.cost.mixedBases, true);
  assert.equal(report.metrics.cost.unknownArms, 0); assert.equal(report.metrics.requests, 4);
  for (const secret of [...Object.values(routerKeys()), 'private-router-body', 'private-request-body']) assert.ok(!JSON.stringify(report).includes(secret));
});

test('provider credentials are disjoint and both selected keys are required before either arm', async t => {
  const f = await temporary(t), { evaluateLlmControl, runLlmControlEvaluationCli } = await subject();
  await assert.rejects(evaluateLlmControl(fixture(), { ...routerDeps(), provider: 'openrouter', apiKeys: keys(), fetchImpl: noCall }), /INVALID_CREDENTIALS|MISSING_OPENROUTER_API_KEY/);
  await assert.rejects(evaluateLlmControl(fixture(), { ...deps(), apiKeys: routerKeys(), fetchImpl: noCall }), /INVALID_CREDENTIALS|MISSING_OPENAI_API_KEY/);
  const rejectedEnvironments = [
    ['openrouter', { TYPESAFE_API_KEY: 'test', OPENAI_API_KEY: 'wrong-provider-secret' }, 'MISSING_OPENROUTER_API_KEY'],
    ['openai', { TYPESAFE_API_KEY: 'test', OPENROUTER_API_KEY: 'wrong-provider-secret' }, 'MISSING_OPENAI_API_KEY'],
    ['openrouter', { OPENROUTER_API_KEY: 'test' }, 'MISSING_TYPESAFE_API_KEY'],
  ];
  for (const [provider, env, reason] of rejectedEnvironments) {
    const output = await runLlmControlEvaluationCli(['--live', '--provider', provider, '--cases', f.input, '--output', f.output], {
      ...(provider === 'openrouter' ? routerDeps() : deps()), env, fetchImpl: noCall,
    });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, reason);
  }
});

test('OpenRouter offline preflight validates its model without any key access', async t => {
  const f = await temporary(t), { runLlmControlEvaluationCli } = await subject();
  const output = await runLlmControlEvaluationCli(['--preflight', '--provider', 'openrouter', '--model', 'openai/gpt-6-luna', '--cases', f.input], {
    ...routerDeps(), env: new Proxy({}, { get: noCall }), fetchImpl: noCall,
  });
  assert.equal(output.exitCode, 0); assert.equal(output.result.provider, 'openrouter');
  assert.equal(output.result.models.openrouter, 'openai/gpt-6-luna');
  for (const argv of [['--preflight', '--provider', 'other'], ['--preflight', '--provider', 'openrouter', '--model', 'gpt-6-luna'],
    ['--preflight', '--model', 'openai/gpt-6-luna'], ['--preflight', '--provider', 'openrouter', '--provider', 'openrouter']]) {
    const invalid = await runLlmControlEvaluationCli(argv, { ...routerDeps(), fetchImpl: noCall });
    assert.equal(invalid.result.reason, 'INVALID_ARGUMENTS');
  }
});

test('OpenRouter explicit env lookup never consults the OpenAI credential and keeps env precedence', async t => {
  const f = await temporary(t), file = join(f.dir, 'private.env');
  await writeFile(file, 'OPENAI_API_KEY=wrong-provider-secret\nOPENROUTER_API_KEY=private-router-file\nTYPESAFE_API_KEY=private-typesafe-secret\n');
  const env = new Proxy({ OPENROUTER_API_KEY: 'private-router-secret' }, { get(target, key) {
    assert.notEqual(key, 'OPENAI_API_KEY'); return target[key];
  } });
  const result = await (await subject()).runLlmControlEvaluationCli(['--live', '--provider', 'openrouter', '--cases', f.input,
    '--output', f.output, '--env-file', file, '--rounds', '1'], { ...routerDeps(), env });
  assert.equal(result.exitCode, 0); assert.equal(result.result.provider, 'openrouter');
  assert.equal(JSON.parse(await readFile(f.output, 'utf8')).provider, 'openrouter');
});

test('unknown OpenRouter credit cost stays unknown and reflected provider fields are discarded', async () => {
  const injected = routerDeps();
  const report = await (await subject()).evaluateLlmControl(fixture(), { ...injected, provider: 'openrouter', apiKeys: routerKeys(), rounds: 1,
    runOpenRouterControl: async (value, options) => ({ ...await injected.runOpenRouterControl(value, options),
      observedProvider: 'private-provider-secret', observedModel: 'openai/gpt-6-luna-private-secret', providerErrorCode: 'private-code-secret',
      decisions: value.tasks.map(task => ({ ...abstention(task.id), outcome: 'error', reason: 'UNEXPECTED_PROVIDER' })),
      cost: { estimatedProviderUsd: 100, reportedProviderUsd: null, upstreamInferenceCostUsd: 0.05, knownUsageUsd: 100,
        basis: 'private-basis-secret', complete: true } }),
  });
  const arm = report.rounds[0].arms[1];
  assert.equal(arm.cost.reportedProviderUsd, null); assert.equal(arm.cost.estimatedProviderUsd, null); assert.equal(arm.cost.knownUsageUsd, null);
  assert.equal(arm.cost.complete, false); assert.equal(arm.observedProvider, null); assert.equal(arm.observedModel, null);
  assert.equal(arm.rows[0].reason, 'UNEXPECTED_PROVIDER'); assert.equal(report.metrics.cost.reportedProviderUsd, null);
  assert.equal(report.metrics.cost.accountedProviderUsd, null); assert.equal(report.metrics.cost.unknownArms, 1);
  assert.ok(!JSON.stringify(report).includes('private-provider-secret')); assert.ok(!JSON.stringify(report).includes('private-basis-secret'));
});

test('real twelve-case CLI uses production OpenRouter and JEV adapters with mocked HTTP and scoped billing', async t => {
  const f = await temporary(t), actual = JSON.parse(await readFile(new URL('../benchmarks/news-triage-cases.json', import.meta.url), 'utf8'));
  const { runLlmControlEvaluationCli } = await subject();
  const offline = await runLlmControlEvaluationCli(['--preflight', '--provider', 'openrouter', '--model', 'openai/gpt-6-luna'], {
    env: new Proxy({}, { get: noCall }), fetchImpl: noCall,
  });
  assert.equal(offline.exitCode, 0); assert.equal(offline.result.caseCount, 12);
  const order = [], wirePackets = [];
  const output = await runLlmControlEvaluationCli(['--live', '--provider', 'openrouter', '--output', f.output, '--rounds', '2'], {
    env: { TYPESAFE_API_KEY: 'fake-typesafe', OPENROUTER_API_KEY: 'fake-openrouter' },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST'); const body = JSON.parse(options.body);
      const auth = new Headers(options.headers).get('authorization');
      for (const item of actual.cases) {
        assert.ok(!options.body.includes(item.id)); assert.ok(!options.body.includes(item.input.task.id));
      }
      const choice = index => actual.cases[index].expected.needsHost ? 'NONE' : actual.cases[index].expected.routeId;
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        order.push('jev'); assert.equal(auth, 'Bearer fake-typesafe'); assert.equal(body.model, 'jev-1.13.0');
        const answers = {};
        for (const [key, question] of Object.entries(body.questions)) {
          const selected = choice(Number(key.slice(1)));
          answers[key] = { type: 'choice', choice: selected, confidence: 0.99,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected ? 1 : 0])) };
        }
        return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers });
      }
      order.push('openrouter'); assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(auth, 'Bearer fake-openrouter'); assert.equal(body.model, 'openai/gpt-6-luna');
      assert.deepEqual(body.provider.only, ['openai']); assert.equal(body.provider.allow_fallbacks, false);
      assert.equal(body.service_tier, 'default'); assert.equal(body.reasoning.effort, 'none');
      const packet = JSON.parse(body.messages.find(message => message.role === 'user').content);
      wirePackets.push(packet);
      for (const [index, task] of packet.tasks.entries()) {
        assert.equal(task.id, `t${index}`); assert.equal(task.task.id, task.id);
        task.task.evidence.forEach((evidence, index) => assert.equal(evidence.id, `e${index}`));
      }
      return Response.json({ model: 'openai/gpt-6-luna-20260922', provider: 'OpenAI',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
          decisions: packet.tasks.map((task, index) => ({ id: task.id, routeId: choice(index) })),
        }) } }], usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230,
          prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 0 },
          cost: 0.003, is_byok: true, cost_details: { upstream_inference_cost: 0.25 } },
      });
    },
  });
  assert.equal(output.exitCode, 0); assert.equal(output.result.provider, 'openrouter');
  assert.deepEqual(order, ['jev', 'openrouter', 'openrouter', 'jev']); assert.deepEqual(wirePackets[0], wirePackets[1]);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.metrics.requests, 4); assert.equal(report.metrics.cost.unknownArms, 0);
  assert.equal(report.metrics.cost.reportedProviderUsd, 0.006); assert.equal(report.metrics.cost.mixedBases, true);
  assert.equal(report.metrics.cost.accountedProviderUsd, report.metrics.cost.estimatedProviderUsd + 0.006);
  for (const round of report.rounds) {
    assert.deepEqual(round.disagreementIds, []);
    for (const arm of round.arms) {
      assert.equal(arm.rows.length, 12); assert.ok(arm.rows.every(row => row.correct));
      if (arm.name === 'openrouter') {
        assert.equal(arm.cost.upstreamInferenceCostUsd, 0.25); assert.equal(arm.cost.isByok, true);
        assert.equal(arm.cost.billingScope, 'openrouter_account_credits'); assert.equal(arm.cost.reportedProviderUsd, 0.003);
        assert.equal(arm.cost.estimatedProviderUsd, null); assert.equal(arm.usage.cacheWriteInputTokens, null);
      }
    }
  }
  for (const value of ['fake-typesafe', 'fake-openrouter', actual.cases[0].input.task.request]) assert.ok(!JSON.stringify(report).includes(value));
});
