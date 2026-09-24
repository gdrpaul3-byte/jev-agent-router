import test from 'node:test';
import assert from 'node:assert/strict';
import { runGoalWorkflow } from '../src/goal.mjs';

const input = () => ({ goal: 'Open the guide', completion: { textIncludes: ['Guide content'] },
  actions: [{ id: 'openGuide', action: 'click', description: 'Open the guide', target: { roles: ['link'], nameEquals: 'Guide' } },
    { id: 'typeQuery', action: 'typeText', description: 'Enter the host query', text: 'host supplied query', target: { roles: ['textbox'] } }],
  observation: { text: 'Search or open Guide', url: 'https://example.test/', title: 'Home', elements: [
    { ref: 5, role: 'link', name: 'Guide' }, { ref: 6, role: 'textbox', name: 'Search', editable: true },
    { ref: 7, role: 'textbox', name: 'Password', protected: true } ] }, history: [] });
const decision = (extra = {}) => ({ status: 'decided', actionId: 'openGuide', ref: 5, confidence: .99, ...extra });
function response(value, extra = {}) {
  return Response.json({ model: 'openai/gpt-6-astra', provider: 'OpenAI', service_tier: 'default',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 5 }, cost: .002, is_byok: false }, ...extra });
}
async function create(options = {}) { return (await import('../benchmarks/browser-llm-decider.mjs')).createBrowserLlmDecider({ apiKey: 'test-key', ...options }); }

test('same host goal/actions/observation/history drive a constrained selection without model-authored inputs', async () => {
  let wire; const decider = await create({ fetchImpl: async (url, options) => { assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); wire = JSON.parse(options.body); return response(decision()); } });
  const original = input(); original.history = [{ actionId: 'typeQuery', ref: 6 }];
  const answer = await decider.decide(original);
  assert.equal(answer.status, 'decided'); assert.equal(answer.actionId, 'openGuide'); assert.equal(answer.ref, 5);
  const payload = JSON.parse(wire.messages[1].content[1].text);
  assert.equal(payload.goal, original.goal); assert.deepEqual(payload.history, original.history);
  assert.equal(payload.hostCompletionMet, false);
  assert.deepEqual(payload.observation, original.observation); assert.equal(payload.actions[1].text, 'host supplied query');
  assert.deepEqual(wire.response_format.json_schema.schema.properties.ref.enum, [-1, 5, 6]);
  assert.deepEqual(wire.tools, []); assert.equal(wire.tool_choice, 'none');
  assert.match(wire.messages[0].content, /untrusted/); assert.equal(wire.reasoning.effort, 'low');
  assert.ok(!Object.hasOwn(answer, 'text')); assert.equal(decider.stats().calls, 1);
  assert.equal(decider.stats().cost.reportedProviderUsd, .002); assert.equal(decider.stats().usage.outputTokens, 20);
  assert.ok(!JSON.stringify(decider.attempts()).includes('test-key'));
});

test('unobserved/protected refs and cross-action mismatches cannot escape host constraints', async () => {
  for (const [value, reason] of [[decision({ ref: 999 }), 'INVALID_OUTPUT'], [decision({ ref: 7 }), 'INVALID_OUTPUT'],
    [decision({ actionId: 'typeQuery', ref: 5 }), 'INVALID_TARGET'], [decision({ confidence: .2 }), 'LOW_CONFIDENCE'],
    [decision({ text: 'model authored input' }), 'INVALID_OUTPUT']]) {
    const decider = await create({ fetchImpl: async () => response(value) });
    const result = await decider.decide(input()); assert.equal(result.status, 'needs_host'); assert.equal(result.reason, reason);
    assert.equal(decider.stats().calls, 1); assert.equal(decider.stats().cost.reportedProviderUsd, .002);
  }
});

test('done requires real completion and blocked abstains, while host-only action templates stay unchanged', async () => {
  const done = { status: 'done', actionId: 'NONE', ref: -1, confidence: .99 };
  const decider = await create({ fetchImpl: async () => response(done) });
  assert.equal((await decider.decide(input())).reason, 'COMPLETION_NOT_VERIFIED');
  const completed = input(); completed.observation.text = 'Guide content';
  assert.equal((await decider.decide(completed)).status, 'done');
  const blocked = await create({ fetchImpl: async () => response({ ...done, status: 'blocked' }) });
  assert.equal((await blocked.decide(input())).reason, 'MODEL_BLOCKED');
  const malformed = await create({ fetchImpl: async () => response({ ...done, actionId: 'openGuide' }) });
  assert.equal((await malformed.decide(completed)).reason, 'INVALID_DECISION');
});

test('call cap, invalid input and concurrency block extra network dispatch', async () => {
  let calls = 0, release; const gate = new Promise(done => { release = done; });
  const decider = await create({ maxCalls: 1, fetchImpl: async () => { calls++; await gate; return response(decision()); } });
  const first = decider.decide(input());
  assert.equal((await decider.decide(input())).reason, 'BUSY'); release(); await first;
  assert.equal((await decider.decide(input())).reason, 'CALL_BUDGET_EXHAUSTED'); assert.equal(calls, 1);
  const off = await create({ maxCalls: 0, fetchImpl: () => assert.fail('No API call') });
  assert.equal((await off.decide(input())).reason, 'CALL_BUDGET_EXHAUSTED'); assert.equal(off.stats().cost.knownUsageUsd, 0);
  const bad = await create({ fetchImpl: () => assert.fail('No API call') });
  assert.equal((await bad.decide({ ...input(), leakedLabels: ['SECRET'] })).reason, 'INVALID_INPUT');
  const hostile = input(); Object.defineProperty(hostile.observation, 'text', { get() { assert.fail('Do not invoke getters'); } });
  assert.equal((await bad.decide(hostile)).reason, 'INVALID_INPUT'); assert.equal(bad.stats().calls, 0);
});

test('HTTP errors retain usage and reported cost, unknown timeout stays unknown with no late mutation', async () => {
  const failed = await create({ fetchImpl: async () => Response.json({ error: { message: 'SECRET raw error' }, usage: { prompt_tokens: 10, completion_tokens: 0, cost: .003 } }, { status: 401 }) });
  assert.equal((await failed.decide(input())).reason, 'HTTP_ERROR'); assert.equal(failed.stats().cost.reportedProviderUsd, .003);
  assert.equal(failed.attempts()[0].httpStatus, 401); assert.ok(!JSON.stringify(failed.attempts()).includes('SECRET'));
  let release; const pending = new Promise(done => { release = done; });
  const slow = await create({ timeoutMs: 15, fetchImpl: async () => ({ ok: true, status: 200, json: () => pending }) });
  assert.equal((await slow.decide(input())).reason, 'TIMEOUT');
  assert.equal(slow.stats().cost.complete, false); assert.equal(slow.stats().cost.reportedProviderUsd, null);
  const frozen = JSON.stringify(slow.stats()); release(await response(decision()).json()); await new Promise(done => setTimeout(done, 20));
  assert.equal(JSON.stringify(slow.stats()), frozen); assert.equal(slow.stats().calls, 1);
});

test('real goal runner accepts the LLM decider and verifies progress before done', async () => {
  let opened = false, calls = 0, clicks = 0;
  const decider = await create({ fetchImpl: async () => { calls++; return response(opened ? { status: 'done', actionId: 'NONE', ref: -1, confidence: .99 } : decision()); } });
  const original = input();
  const target = { getObservation: async () => ({ ...original.observation, text: opened ? 'Guide content' : original.observation.text }),
    click: async ref => { assert.equal(ref, 5); clicks++; opened = true; }, typeText: () => assert.fail('No typing selected') };
  const result = await runGoalWorkflow({ ...original, target, decider, maxSteps: 3, maxDurationMs: 2000 });
  assert.equal(result.status, 'completed'); assert.equal(result.completedSteps, 1); assert.equal(clicks, 1); assert.equal(calls, 2);
  const copied = decider.attempts(); copied[0].usage.inputTokens = 999;
  assert.equal(decider.attempts()[0].usage.inputTokens, 100);
});
