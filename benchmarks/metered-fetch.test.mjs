import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeteredFetch } from './metered-fetch.mjs';

const endpoint = 'https://api.typesafe.ai/v1/systemone';
const secret = 'private-credential-and-screen-value';
const body = JSON.stringify({ state: { private: secret, label: '도서관' }, questions: { operation: {}, target_open: {} } });
const request = { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body, redirect: 'error' };

test('forwards exactly one request and preserves the original unread Response', async () => {
  let calls = 0;
  const response = Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 123, output_tokens: 27 }, answers: { private: secret } });
  const meter = createMeteredFetch({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, endpoint); assert.equal(options, request); return response;
  } });
  const returned = await meter.fetchImpl(endpoint, request);
  assert.equal(returned, response); assert.equal(response.bodyUsed, false); assert.equal(calls, 1);
  const settled = await meter.flush();
  assert.equal(settled.pendingUsage, 0); assert.equal(settled.inputTokens, 123); assert.equal(settled.outputTokens, 27);
  const [record] = meter.records();
  assert.equal(record.model, 'jev-1.13.0'); assert.equal(record.httpStatus, 200);
  assert.equal(record.questionCount, 2); assert.equal(record.requestBytes, new TextEncoder().encode(body).byteLength);
  assert.ok(record.latencyMs >= 0); assert.ok(!JSON.stringify([record, settled]).includes(secret));
  assert.equal((await response.json()).answers.private, secret);
});

test('captures billed usage on an HTTP failure without changing error response semantics', async () => {
  const response = Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 19, output_tokens: 0 }, error: secret }, { status: 429 });
  const meter = createMeteredFetch({ fetchImpl: async () => response });
  assert.equal(await meter.fetchImpl(endpoint, request), response);
  const stats = await meter.flush();
  assert.equal(stats.errors, 1); assert.equal(stats.inputTokens, 19); assert.equal(stats.outputTokens, 0);
  assert.equal(meter.records()[0].httpStatus, 429);
  assert.ok(!JSON.stringify(meter.records()).includes(secret));
});

test('unknown usage remains null while known partial subtotals are explicit', async () => {
  let calls = 0;
  const meter = createMeteredFetch({ fetchImpl: async () => Response.json(++calls === 1
    ? { model: 'jev-latest', usage: { input_tokens: 10 } }
    : { model: 'jev-1.13.0', usage: { output_tokens: 3 } }) });
  await meter.fetchImpl(endpoint, request); await meter.fetchImpl(endpoint, request);
  const stats = await meter.flush();
  assert.equal(stats.inputTokens, null); assert.equal(stats.outputTokens, null);
  assert.equal(stats.knownInputTokens, 10); assert.equal(stats.knownOutputTokens, 3);
  assert.equal(stats.inputUsageCalls, 1); assert.equal(stats.outputUsageCalls, 1);
  assert.equal(meter.records()[0].outputTokens, null); assert.equal(meter.records()[1].inputTokens, null);
});

test('malformed and nonnumeric provider metadata never leaks into records', async () => {
  const samples = [new Response(secret), Response.json({ model: `jev-${secret}\n`, usage: { input_tokens: -1, output_tokens: '25' } }),
    Response.json({ model: 'jev-1.13.0', usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1.5 } })];
  const meter = createMeteredFetch({ fetchImpl: async () => samples.shift() });
  for (let index = 0; index < 3; index++) await meter.fetchImpl(endpoint, request);
  const stats = await meter.flush();
  assert.equal(stats.inputTokens, null); assert.equal(stats.outputTokens, null);
  assert.ok(!JSON.stringify([stats, meter.records()]).includes(secret));
  assert.equal(meter.records()[1].model, null);
});

test('transport errors propagate unchanged but their messages are never recorded', async () => {
  const error = new Error(secret);
  const meter = createMeteredFetch({ fetchImpl: async () => { throw error; } });
  await assert.rejects(meter.fetchImpl(endpoint, request), value => value === error);
  const stats = await meter.flush();
  assert.equal(stats.calls, 1); assert.equal(stats.errors, 1); assert.equal(stats.inputTokens, null);
  assert.equal(meter.records()[0].error, 'TRANSPORT_FAILED');
  assert.ok(!JSON.stringify([stats, meter.records()]).includes(secret));
});

test('rejects other endpoints before invoking the transport', async () => {
  let calls = 0;
  const meter = createMeteredFetch({ fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const url of ['https://example.com/v1/systemone', `${endpoint}?key=${secret}`, `https://user:${secret}@api.typesafe.ai/v1/systemone`]) {
    await assert.rejects(meter.fetchImpl(url, request), /METERED_FETCH_ENDPOINT_NOT_ALLOWED/);
  }
  assert.equal(calls, 0); assert.equal(meter.stats().calls, 0);
});

test('bounded flush reports pending usage then accepts late metadata without a second API call', async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  let calls = 0;
  const meter = createMeteredFetch({ fetchImpl: async () => { calls++; return response; } });
  await meter.fetchImpl(endpoint, request);
  const pending = await meter.flush({ timeoutMs: 5 });
  assert.equal(pending.pendingUsage, 1); assert.equal(pending.inputTokens, null); assert.equal(calls, 1);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 7, output_tokens: 2 } })));
  controller.close();
  const complete = await meter.flush({ timeoutMs: 2000 });
  assert.equal(complete.pendingUsage, 0); assert.equal(complete.inputTokens, 7); assert.equal(complete.outputTokens, 2);
  assert.equal(response.bodyUsed, false); assert.equal(calls, 1);
  await response.text();
});

test('returned record snapshots cannot modify the meter and no-clone responses retain unknown usage', async () => {
  const response = { status: 200, ok: true, json: async () => ({ usage: { input_tokens: 999 } }) };
  const meter = createMeteredFetch({ fetchImpl: async () => response });
  assert.equal(await meter.fetchImpl(endpoint, request), response);
  meter.records()[0].inputTokens = 999;
  assert.equal(meter.records()[0].inputTokens, null); assert.equal(meter.stats().inputTokens, null);
  assert.equal(meter.stats().pendingUsage, 0);
});

test('flush remains bounded while transport headers are pending after a caller timeout', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const meter = createMeteredFetch({ fetchImpl: async () => { await waiting; return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 8, output_tokens: 1 } }); } });
  const requestPromise = meter.fetchImpl(endpoint, request);
  const pending = await meter.flush({ timeoutMs: 5 });
  assert.equal(pending.pendingRequests, 1); assert.equal(pending.pendingUsage, 0);
  assert.equal(pending.inputTokens, null); assert.equal(pending.outputTokens, null);
  release(); await requestPromise;
  const complete = await meter.flush();
  assert.equal(complete.pendingRequests, 0); assert.equal(complete.pendingUsage, 0);
  assert.equal(complete.inputTokens, 8); assert.equal(complete.outputTokens, 1);
});
