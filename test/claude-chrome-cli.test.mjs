import test from 'node:test';
import assert from 'node:assert/strict';

async function subject() {
  let value;
  try { value = await import('../src/claude-chrome-cli.mjs'); }
  catch { assert.fail('The Claude Chrome CLI module must exist'); }
  return value;
}
const input = () => ({
  plan: { goal: 'Open the guide', allowedOrigins: ['https://example.com'],
    actions: [{ id: 'open', action: 'click', description: 'Open guide', target: { roles: ['link'], nameEquals: 'Guide' } }],
    completion: { textIncludes: 'Guide contents' } },
  observation: { source: 'claude-in-chrome', observedAtEpochMs: 1000, tab: { id: 12, url: 'https://example.com' },
    text: 'Guide', elements: [{ ref: 'ref_1', role: 'link', name: 'Guide', visible: true }] },
});
const choice = (selected, keys) => ({ type: 'choice', choice: selected, confidence: 0.99,
  probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.98 : 0.02 / (keys.length - 1)])) });

test('CLI decide meters exactly one direct TypeSafe request without printing the key', async () => {
  let calls = 0;
  const result = await (await subject()).runClaudeChromeCommand('decide', input(), {
    apiKey: 'fake-secret-for-test', now: () => 1100,
    fetchImpl: async (url, request) => {
      calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(request.headers.Authorization, 'Bearer fake-secret-for-test');
      return new Response(JSON.stringify({ model: 'jev-latest', usage: { input_tokens: 100, output_tokens: 0 },
        answers: { operation: choice('open', ['open', 'DONE', 'BLOCKED']), target_open: choice('e_0', ['e_0', 'NONE']) } }), { status: 200 });
    },
  });
  assert.equal(result.status, 'proposed'); assert.equal(calls, 1);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.cost.estimatedJevUsd, 100 * 0.042 / 1000000);
  assert.equal(result.cost.hostCostUsd, null);
  assert.ok(!JSON.stringify(result).includes('fake-secret-for-test'));
});

test('invalid plans and API endpoints are rejected before secrets or network access', async () => {
  const api = await subject();
  for (const data of [{}, { ...input(), api: { endpoint: 'https://other.example' } }]) {
    const result = await api.runClaudeChromeCommand('decide', data, { envFile: 'missing-file', fetchImpl: () => assert.fail('must not call'), now: () => 1100 });
    assert.equal(result.status, 'needs_host');
    assert.notEqual(result.reason, 'JEV_CONFIG_READ_ERROR');
  }
});

test('unknown provider usage is null instead of a fabricated zero cost', async () => {
  const result = await (await subject()).runClaudeChromeCommand('decide', input(), { apiKey: 'test', now: () => 1100,
    fetchImpl: async () => new Response('{}', { status: 503 }) });
  assert.equal(result.reason, 'HTTP_ERROR');
  assert.equal(result.cost.estimatedJevUsd, null);
  assert.equal(result.usage.calls, 1);
});

test('authorization is local and does not read a key or make a billable request', async () => {
  const result = await (await subject()).runClaudeChromeCommand('authorize', input(), { envFile: 'missing-file', fetchImpl: () => assert.fail('must not call'), now: () => 1100 });
  assert.equal(result.reason, 'INVALID_PROPOSAL');
});
