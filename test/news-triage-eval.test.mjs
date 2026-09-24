import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function subject() {
  let value;
  try { value = await import('../benchmarks/news-triage-eval.mjs'); }
  catch { assert.fail('The bounded news triage evaluator must exist'); }
  return value;
}
const cases = () => [
  { id: 'useful', label: 'case one', input: { task: { id: 'task-useful', revision: 1, request: 'private-task-request',
    evidence: [{ id: 'evidence', text: 'private-evidence-text' }] }, routes: [
      { id: 'research', description: 'Read sources', kind: 'read' },
      { id: 'publish', description: 'Publish externally', kind: 'write' },
    ], baselineRouteId: 'research' }, expected: { routeId: 'research', requiresHostApproval: false } },
  { id: 'unavailable', label: 'case two', input: { task: { id: 'task-unavailable', revision: 1, request: 'Required worker is unavailable' },
    routes: [{ id: 'review', description: 'Review only', kind: 'draft' }], baselineRouteId: 'review' }, expected: { needsHost: true } },
];
const selected = (routeId = 'research', requiresHostApproval = false) => ({ status: 'selected', routeId, requiresHostApproval,
  confidence: 0.95, margin: 0.9, model: 'jev-1.13.0', latencyMs: 1 });
const abstain = reason => ({ status: 'needs_host', reason: reason ?? 'NO_SAFE_ROUTE', latencyMs: 1 });
const usageResponse = (tokens = 10) => new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: tokens, output_tokens: 0 } }), { status: 200 });
const post = options => options.fetchImpl('https://api.typesafe.ai/v1/systemone', {
  method: 'POST', body: JSON.stringify({ questions: { route: {} } }),
});
const fullCost = (calls = 1, tokens = 100) => ({ calls, inputTokens: tokens, outputTokens: 0, knownInputTokens: tokens,
  knownOutputTokens: 0, inputUsageCalls: calls, outputUsageCalls: calls, pendingRequests: 0, pendingUsage: 0,
  errors: 0, estimatedJevUsd: tokens * 0.042 / 1000000, knownUsageUsd: tokens * 0.042 / 1000000, complete: true });
function runners(order = []) {
  return {
    decideRoute: async (input, options) => {
      order.push('single'); await post(options);
      return input.task.id === 'task-unavailable' ? abstain() : selected();
    },
    decideRouteBatch: async (inputs, options) => {
      order.push('batch'); await post(options);
      return { status: 'decided', decisions: inputs.map(input => ({ taskId: input.task.id, revision: input.task.revision,
        ...(input.task.id === 'task-unavailable' ? abstain() : selected()) })), cost: fullCost(), requests: [{ index: 1, inputTokens: 100, outputTokens: 0, model: 'jev-1.13.0', error: null }] };
    },
    fetchImpl: async () => usageResponse(),
  };
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-news-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, body = { schemaVersion: 1, synthetic: true, language: 'ko', cases: cases() }) {
  const dir = await temporary(t), file = join(dir, 'cases.json');
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  return { dir, file, output: join(dir, 'report.json') };
}
const noCall = () => assert.fail('invalid/unauthorized evaluator input must not dispatch');

test('two rounds reverse cohort order with fixed pinned configuration and no per-item batch cost', async () => {
  const order = [], progress = [];
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { apiKey: 'private-key', ...runners(order),
    onProgress: report => progress.push(structuredClone(report)) });
  assert.deepEqual(order, ['single', 'single', 'batch', 'batch', 'single', 'single']);
  assert.equal(report.status, 'complete'); assert.equal(report.rounds.length, 2);
  assert.deepEqual(report.config, { mode: 'shadow', model: 'jev-1.13.0', maxInputBytes: 60000, timeoutMs: 10000, maxCalls: 26 });
  assert.deepEqual(report.rounds.map(round => round.order), [['single', 'batch'], ['batch', 'single']]);
  assert.equal(report.metrics.cost.calls, 6); assert.equal(report.metrics.cost.inputTokens, 240);
  for (const round of report.rounds) {
    assert.deepEqual(round.disagreementIds, []);
    for (const cohort of round.cohorts) {
      assert.equal(cohort.rows.length, 2); assert.equal(cohort.metrics.routing.acceptedAccuracy, 1);
      assert.equal(cohort.metrics.expectedHost.correctness, 1); assert.ok(cohort.wallLatencyMs >= 0);
      for (const row of cohort.rows) assert.equal(Object.hasOwn(row, 'cost'), false);
    }
  }
  assert.ok(progress.length >= 6);
  const serialized = JSON.stringify(report);
  for (const secret of ['private-key', 'private-task-request', 'private-evidence-text']) assert.ok(!serialized.includes(secret));
});

test('the full 12-case fixture uses at most 26 POSTs in two rounds', async () => {
  const fixture = JSON.parse(await readFile(new URL('../benchmarks/news-triage-cases.json', import.meta.url), 'utf8'));
  let calls = 0;
  const report = await (await subject()).evaluateNewsTriageCases(fixture.cases, {
    ...runners(), apiKey: 'test', fetchImpl: async (_, options) => { assert.equal(options.method, 'POST'); calls++; return usageResponse(); },
  });
  assert.equal(calls, 26); assert.equal(report.plannedCalls, 26); assert.equal(report.metrics.attemptedRequests, 26);
});

test('approval mismatch is incorrect, expected-host HTTP failure is an error, and disagreements are recorded', async () => {
  const input = cases(); input[0].expected = { routeId: 'publish', requiresHostApproval: true };
  const report = await (await subject()).evaluateNewsTriageCases(input, { ...runners(), apiKey: 'test', rounds: 1,
    decideRoute: async (task, options) => { await post(options); return task.task.id === 'task-useful' ? selected('publish', false) : abstain('HTTP_ERROR'); },
    decideRouteBatch: async inputs => ({ status: 'decided', cost: fullCost(0, 0), requests: [], decisions: inputs.map(input => ({
      taskId: input.task.id, revision: input.task.revision, ...(input.task.id === 'task-useful' ? selected('publish', true) : abstain()) })) }),
  });
  const [single, batch] = report.rounds[0].cohorts;
  assert.equal(single.rows[0].correct, false); assert.equal(single.metrics.routing.acceptedAccuracy, 0);
  assert.equal(single.metrics.expectedHost.correctAbstentions, 0); assert.equal(single.metrics.outcomes.errors, 1);
  assert.equal(batch.metrics.routing.acceptedAccuracy, 1); assert.equal(batch.metrics.expectedHost.correctness, 1);
  assert.deepEqual(report.rounds[0].disagreementIds, ['useful', 'unavailable']);
});

test('unknown provider usage stays null in cohort and report totals', async () => {
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  const single = report.rounds[0].cohorts[0];
  assert.equal(single.cost.calls, 2); assert.equal(single.cost.inputTokens, null); assert.equal(single.cost.estimatedJevUsd, null);
  assert.equal(report.metrics.cost.estimatedJevUsd, null); assert.equal(report.metrics.cost.knownInputTokens, 100);
  assert.equal(report.metrics.cost.unknownCohorts, 1);
});

test('batch global failures preserve aggregate billing once and never count as correct expected-host abstention', async () => {
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    decideRouteBatch: async (_, options) => { await post(options); return { status: 'needs_host', reason: 'HTTP_ERROR',
      cost: { ...fullCost(), inputTokens: null, estimatedJevUsd: null, complete: false }, requests: [{ index: 1, error: 'HTTP_ERROR' }] }; },
  });
  const batch = report.rounds[0].cohorts[1];
  assert.equal(batch.aggregateError, 'HTTP_ERROR'); assert.equal(batch.rows.length, 2);
  assert.equal(batch.metrics.outcomes.errors, 2); assert.equal(batch.metrics.expectedHost.correctAbstentions, 0);
  assert.equal(report.metrics.aggregateErrors, 1); assert.equal(report.metrics.cost.calls, 3);
});

test('batch identities are checked so missing/duplicate decisions cannot silently shift labels', async () => {
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    decideRouteBatch: async () => ({ status: 'decided', cost: fullCost(0, 0), requests: [], decisions: [
      { taskId: 'task-useful', revision: 1, ...selected() }, { taskId: 'task-useful', revision: 1, ...selected() },
    ] }),
  });
  const batch = report.rounds[0].cohorts[1];
  assert.equal(batch.aggregateError, 'INVALID_RUNNER_RESULT'); assert.equal(batch.metrics.outcomes.errors, 2);
});

test('every completed call is checkpointed, and later exceptions keep earlier measured costs', async () => {
  const checkpoints = [];
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    decideRoute: async (input, options) => { await post(options); if (input.task.id === 'task-unavailable') throw new Error('private-provider-path'); return selected(); },
    onProgress: report => checkpoints.push(structuredClone(report)),
  });
  assert.ok(checkpoints.some(report => report.rounds[0]?.cohorts[0]?.rows.length === 1 && report.metrics.cost.calls === 1));
  assert.equal(report.metrics.cost.calls, 3); assert.equal(report.metrics.cost.inputTokens, 120);
  assert.equal(report.rounds[0].cohorts[0].rows[1].decision.reason, 'EVALUATION_RUN_FAILED');
  assert.ok(!JSON.stringify(report).includes('private-provider-path'));
});

test('a failed checkpoint stops before another paid call', async () => {
  let calls = 0;
  await assert.rejects((await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    fetchImpl: async () => { calls++; return usageResponse(); }, onProgress: () => { throw new Error('cannot persist'); },
  }), /cannot persist/);
  assert.ok(calls <= 1);
});

test('report sanitization drops provider text, unknown statuses, models, paths and key-bearing metrics', async () => {
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'secret-api', rounds: 1,
    decideRouteBatch: async inputs => ({ status: 'decided', cost: { ...fullCost(), raw: 'secret-api' },
      requests: [{ model: 'C:/private-local-path', error: 'secret-api', body: 'private-evidence-text' }],
      decisions: inputs.map(input => ({ taskId: input.task.id, revision: 1, status: 'private-status', reason: 'secret-api',
        model: 'C:/private-local-path', raw: 'private-evidence-text' })) }),
  });
  const text = JSON.stringify(report);
  for (const value of ['secret-api', 'private-local-path', 'private-evidence-text', 'private-status']) assert.ok(!text.includes(value));
});

test('invalid options, excessive cases and conflicting labels fail before any network call', async () => {
  const { evaluateNewsTriageCases } = await subject();
  for (const options of [{ rounds: 0 }, { rounds: 3 }, { rounds: 1.5 }, { surprise: true }, { apiKey: '' }]) {
    await assert.rejects(evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', fetchImpl: noCall, ...options }));
  }
  const bad = cases(); bad[0].expected.requiresHostApproval = true;
  await assert.rejects(evaluateNewsTriageCases(bad, { ...runners(), apiKey: 'test', fetchImpl: noCall }));
  await assert.rejects(evaluateNewsTriageCases(Array.from({ length: 13 }, () => cases()[0]), { apiKey: 'test', fetchImpl: noCall }));
});

test('CLI requires explicit live/output, bounds rounds, and rejects duplicate or unknown flags', async () => {
  const { runNewsTriageEvaluationCli } = await subject();
  for (const argv of [[], ['--output', 'a.json'], ['--live'], ['--live', '--output', 'a.json', '--rounds', '3'],
    ['--live', '--output', 'a.json', '--rounds', '1.5'], ['--live', '--live', '--output', 'a.json'],
    ['--live', '--output', 'a.json', '--anything', 'x'], ['--live', '--output', 'a.json', '--rounds'],
    ['--help', '--live']]) {
    const output = await runNewsTriageEvaluationCli(argv, { env: { TYPESAFE_API_KEY: 'test' }, ...runners(), fetchImpl: noCall });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, 'INVALID_ARGUMENTS');
  }
  const help = await runNewsTriageEvaluationCli(['--help'], { env: {}, fetchImpl: noCall });
  assert.equal(help.exitCode, 0); assert.equal(help.result.status, 'help');
});

test('CLI refuses an existing output before paid dispatch and never overwrites it', async t => {
  const f = await fixture(t); await writeFile(f.output, 'preserve-original');
  const output = await (await subject()).runNewsTriageEvaluationCli(['--live', '--cases', f.file, '--output', f.output], {
    env: { TYPESAFE_API_KEY: 'test' }, ...runners(), fetchImpl: noCall,
  });
  assert.equal(output.result.reason, 'OUTPUT_EXISTS'); assert.equal(await readFile(f.output, 'utf8'), 'preserve-original');
});

test('CLI uses an explicit env file, saves all results, and does not expose key or paths in stdout/report', async t => {
  const f = await fixture(t), envFile = join(f.dir, 'private-env-file');
  await writeFile(envFile, 'TYPESAFE_API_KEY=private-env-secret');
  const output = await (await subject()).runNewsTriageEvaluationCli(['--live', '--cases', f.file, '--output', f.output,
    '--rounds', '1', '--env-file', envFile], { env: {}, ...runners() });
  assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'complete');
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.rounds.length, 1); assert.equal(report.status, 'complete');
  const text = JSON.stringify([report, output]);
  for (const privateValue of [f.dir, envFile, 'private-env-secret', 'private-task-request', 'private-evidence-text']) assert.ok(!text.includes(privateValue));
});

test('CLI bounded fixture reads reject malformed, non-file, oversized, duplicate-label inputs', async t => {
  const f = await fixture(t), { runNewsTriageEvaluationCli } = await subject();
  for (const body of [' '.repeat(1000001), '{private-secret', JSON.stringify({ schemaVersion: 1, synthetic: true, cases: [cases()[0], cases()[0]] })]) {
    await writeFile(f.file, body);
    const output = await runNewsTriageEvaluationCli(['--live', '--cases', f.file, '--output', f.output], {
      env: { TYPESAFE_API_KEY: 'test' }, ...runners(), fetchImpl: noCall,
    });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, body.length > 1000000 ? 'INPUT_TOO_LARGE' : 'INVALID_EVALUATION_CASES');
    assert.ok(!JSON.stringify(output).includes('private-secret'));
  }
  const directory = await runNewsTriageEvaluationCli(['--live', '--cases', f.dir, '--output', f.output], {
    env: { TYPESAFE_API_KEY: 'test' }, ...runners(), fetchImpl: noCall,
  });
  assert.equal(directory.result.reason, 'INVALID_EVALUATION_CASES');
});

test('default single and batch core APIs share the real typed request contract with mocked HTTP only', async () => {
  let calls = 0;
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { apiKey: 'test-only-key', rounds: 1,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'jev-1.13.0');
      const answers = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const selectedId = Object.hasOwn(question.criteria, 'research') ? 'research' : 'NONE';
        const keys = Object.keys(question.criteria);
        answers[key] = { type: 'choice', choice: selectedId, confidence: 0.99,
          probabilities: Object.fromEntries(keys.map(key => [key, key === selectedId ? 1 : 0])) };
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 77, output_tokens: 0 }, answers }), { status: 200 });
    },
  });
  assert.equal(calls, 3); assert.equal(report.metrics.attemptedRequests, 3);
  assert.equal(report.metrics.cost.inputTokens, 231); assert.equal(report.metrics.cost.calls, 3);
  assert.deepEqual(report.rounds[0].disagreementIds, []);
  for (const cohort of report.rounds[0].cohorts) {
    assert.equal(cohort.metrics.routing.acceptedAccuracy, 1); assert.equal(cohort.metrics.expectedHost.correctness, 1);
  }
});

test('transport enforces the 26-call cap even if an injected runner wrongly dispatches extra calls', async () => {
  let upstreamCalls = 0;
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { apiKey: 'test', rounds: 1, ...runners(),
    fetchImpl: async () => { upstreamCalls++; return usageResponse(); },
    decideRoute: async (_, options) => {
      for (let index = 0; index < 30; index++) await post(options);
      return selected();
    },
  });
  assert.equal(upstreamCalls, 26); assert.equal(report.metrics.attemptedRequests, 26);
  assert.ok(report.metrics.outcomes.errors > 0);
});

test('processing latency excludes checkpoint I/O while wall latency keeps harness overhead visible', async () => {
  const report = await (await subject()).evaluateNewsTriageCases(cases(), { ...runners(), apiKey: 'test', rounds: 1,
    onProgress: async snapshot => {
      const cohort = snapshot.rounds[0]?.cohorts[0];
      if (cohort?.kind === 'single' && cohort.status === 'running') await new Promise(resolve => setTimeout(resolve, 40));
    },
  });
  const [single, batch] = report.rounds[0].cohorts;
  assert.ok(Number.isFinite(single.processingLatencyMs)); assert.ok(Number.isFinite(batch.processingLatencyMs));
  assert.ok(single.wallLatencyMs - single.processingLatencyMs >= 60,
    'Two 40ms checkpoints must not count toward single API processing latency');
  assert.ok(batch.processingLatencyMs <= batch.wallLatencyMs);
});

test('combined batch preflight rejects oversized requests before keys or any paid/injected runner calls', async () => {
  const data = cases();
  for (const item of data) item.input.task.request = 'x'.repeat(32000);
  const { prepareRouteRequest } = await import('../src/router.mjs');
  for (const item of data) assert.equal(prepareRouteRequest(item.input, { maxInputBytes: 60000 }).status, 'prepared');
  await assert.rejects((await subject()).evaluateNewsTriageCases(data, {
    envFile: 'private-nonexistent-env', fetchImpl: noCall, decideRoute: noCall, decideRouteBatch: noCall,
  }), /INPUT_TOO_LARGE/);
});
