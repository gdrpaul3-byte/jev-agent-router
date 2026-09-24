import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkServerIdentity } from 'node:tls';
import { runInNewContext } from 'node:vm';
import { createSystemCaFetch } from '../benchmarks/system-ca-fetch.mjs';

const URL = 'https://openrouter.ai/api/v1/chat/completions';
const JEV = 'https://api.typesafe.ai/v1/systemone';
const MODELS = 'https://openrouter.ai/api/v1/models';
const roots = kind => kind === 'default' ? ['default-ca', 'shared-ca'] : ['system-ca', 'shared-ca'];
function fakeRequest(run) {
  const calls = [];
  const requestImpl = (url, options, callback) => {
    const request = new EventEmitter(); request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = body => { calls.at(-1).body = body; queueMicrotask(() => run?.({ request, callback, options, url })); };
    calls.push({ url, options, request }); return request;
  };
  return { requestImpl, calls, fetch: createSystemCaFetch({ requestImpl, getCACertificates: roots }) };
}
function response(callback, { status = 200, headers = {}, chunks = [], end = true } = {}) {
  const incoming = new EventEmitter(); incoming.statusCode = status; incoming.headers = headers; incoming.destroyed = false;
  incoming.destroy = () => { incoming.destroyed = true; };
  callback(incoming);
  for (const chunk of chunks) incoming.emit('data', chunk);
  if (end) incoming.emit('end');
  return incoming;
}
const options = (overrides = {}) => ({ method: 'POST', redirect: 'error', signal: new AbortController().signal,
  headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' }, body: '{"model":"test"}', ...overrides });

test('combines default/system CAs, verifies certificates and hostnames, and returns clonable Response', async () => {
  const mock = fakeRequest(({ callback }) => response(callback, { headers: { 'content-type': 'application/json' }, chunks: [Buffer.from('{"usage":{"cost":0.01}}')] }));
  const result = await mock.fetch(URL, options());
  assert.equal(result.status, 200); assert.equal(result.ok, true);
  assert.deepEqual(await result.clone().json(), { usage: { cost: 0.01 } });
  assert.deepEqual(await result.json(), { usage: { cost: 0.01 } });
  assert.equal(mock.calls.length, 1);
  const { options: tls, body } = mock.calls[0];
  assert.deepEqual(tls.ca, ['default-ca', 'shared-ca', 'system-ca']);
  assert.equal(tls.rejectUnauthorized, true); assert.equal(tls.checkServerIdentity, checkServerIdentity);
  assert.equal(tls.agent, false); assert.equal(tls.servername, 'openrouter.ai');
  assert.equal(tls.headers.authorization, 'Bearer test-only-token');
  assert.equal(tls.headers['accept-encoding'], 'identity');
  assert.equal(tls.headers['content-length'], String(body.length));
});

test('permits TypeSafe POST and fixed free HEAD endpoints without inventing response content', async () => {
  const mock = fakeRequest(({ callback }) => response(callback, { status: 404 }));
  assert.equal((await mock.fetch(JEV, options())).status, 404);
  for (const url of [MODELS, URL, JEV]) {
    const result = await mock.fetch(url, options({ method: 'HEAD', body: undefined }));
    assert.equal(result.status, 404); assert.equal(await result.text(), '');
  }
  assert.equal(mock.calls.length, 4);
  const largeHead = fakeRequest(({ callback }) => response(callback, { headers: { 'content-length': String(10 * 1024 * 1024) } }));
  assert.equal(await (await largeHead.fetch(MODELS, options({ method: 'HEAD', body: undefined }))).text(), '');
});

test('unapproved endpoints, methods, redirects and missing signals fail before any request', async () => {
  const mock = fakeRequest();
  for (const [url, init] of [
    ['http://openrouter.ai/api/v1/chat/completions', options()],
    [URL + '?key=secret', options()], [URL + '#fragment', options()],
    ['https://openrouter.ai:443/api/v1/chat/completions', options()],
    ['https://user:secret@openrouter.ai/api/v1/chat/completions', options()],
    ['https://attacker.example/api/v1/chat/completions', options()],
    [MODELS, options()], [URL, options({ method: 'GET' })],
    [URL, options({ signal: undefined })], [URL, options({ redirect: 'follow' })],
    [URL, options({ headers: { Host: 'other.example' } })],
    [URL, options({ headers: { 'Content-Length': '100' } })],
    [URL, options({ method: 'HEAD' })], [URL, options({ body: { secret: 'value' } })],
    [URL, options({ body: Buffer.alloc(1024 * 1024 + 1) })],
  ]) await assert.rejects(mock.fetch(url, init), { message: 'INVALID_FETCH_REQUEST' });
  assert.equal(mock.calls.length, 0);
});

test('redirects are rejected without following or forwarding credentials a second time', async () => {
  let incoming;
  const mock = fakeRequest(({ callback }) => { incoming = response(callback, { status: 307, headers: { location: 'https://attacker.example/secret' } }); });
  await assert.rejects(mock.fetch(URL, options()), { message: 'HTTPS_REDIRECT_REJECTED' });
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].request.destroyed, true); assert.equal(incoming.destroyed, true);
});

test('response body cap applies to both declared size and streamed chunks', async () => {
  for (const configuration of [
    { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } },
    { chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.from('!')] },
  ]) {
    const mock = fakeRequest(({ callback }) => response(callback, configuration));
    await assert.rejects(mock.fetch(URL, options()), { message: 'RESPONSE_TOO_LARGE' });
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].request.destroyed, true);
  }
  const limit = fakeRequest(({ callback }) => response(callback, { chunks: [Buffer.alloc(2 * 1024 * 1024)] }));
  assert.equal((await (await limit.fetch(URL, options())).arrayBuffer()).byteLength, 2 * 1024 * 1024);
});

test('already aborted calls do not send and active abort stops response consumption', async () => {
  const before = new AbortController(); before.abort(new Error('secret abort reason'));
  const absent = fakeRequest();
  await assert.rejects(absent.fetch(URL, options({ signal: before.signal })), { name: 'AbortError', message: 'REQUEST_ABORTED' });
  assert.equal(absent.calls.length, 0);
  const during = new AbortController(); let incoming;
  const active = fakeRequest(({ callback }) => {
    incoming = response(callback, { chunks: [Buffer.from('partial')], end: false });
    during.abort(new Error('private reason'));
    incoming.emit('end');
  });
  await assert.rejects(active.fetch(URL, options({ signal: during.signal })), { name: 'AbortError', message: 'REQUEST_ABORTED' });
  assert.equal(active.calls.length, 1); assert.equal(active.calls[0].request.destroyed, true); assert.equal(incoming.destroyed, true);
});

test('caller deadline works while awaiting headers and no retry occurs on TLS errors', async () => {
  const controller = new AbortController();
  const hanging = fakeRequest(() => controller.abort());
  await assert.rejects(hanging.fetch(URL, options({ signal: controller.signal })), { name: 'AbortError' });
  const failed = fakeRequest(({ request }) => request.emit('error', new Error('SELF_SIGNED_CERT_IN_CHAIN with secret key')));
  await assert.rejects(failed.fetch(URL, options()), { message: 'HTTPS_REQUEST_FAILED' });
  assert.equal(failed.calls.length, 1);
});

test('response errors and premature close remain sanitized and compressed bodies are refused', async () => {
  for (const event of ['error', 'aborted', 'close']) {
    const mock = fakeRequest(({ callback }) => {
      const incoming = response(callback, { end: false }); incoming.emit(event, new Error('SECRET'));
    });
    await assert.rejects(mock.fetch(URL, options()), { message: 'HTTPS_RESPONSE_FAILED' });
  }
  const compressed = fakeRequest(({ callback }) => response(callback, { headers: { 'content-encoding': 'gzip' } }));
  await assert.rejects(compressed.fetch(URL, options()), { message: 'UNSUPPORTED_RESPONSE_ENCODING' });
});

test('unavailable trust stores fail closed without printing certificate or path details', () => {
  assert.throws(() => createSystemCaFetch({ getCACertificates: () => { throw new Error('PRIVATE_PATH'); } }), { message: 'SYSTEM_CA_UNAVAILABLE' });
  assert.throws(() => createSystemCaFetch({ getCACertificates: () => [] }), { message: 'SYSTEM_CA_UNAVAILABLE' });
});

test('foreign Response.json objects are normalized at the boundary, including clones', async () => {
  const NativeResponse = globalThis.Response;
  const ForeignResponse = runInNewContext(`
    class ForeignResponse extends BaseResponse {
      async json() { return JSON.parse(await this.text()); }
      clone() {
        const copy = super.clone();
        return new ForeignResponse(copy.body, { status: copy.status, headers: copy.headers });
      }
    }
    ForeignResponse;
  `, { BaseResponse: NativeResponse });
  const foreign = await new ForeignResponse('{"model":"example"}').json();
  assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype);
  globalThis.Response = ForeignResponse;
  try {
    const mock = fakeRequest(({ callback }) => response(callback, { chunks: [Buffer.from('{"model":"example","usage":{"cost":0.01}}')] }));
    const result = await mock.fetch(URL, options());
    assert.ok(result instanceof NativeResponse);
    const firstClone = result.clone(), secondClone = firstClone.clone();
    for (const item of [result, firstClone, secondClone]) {
      assert.equal(item.bodyUsed, false);
      const parsed = await item.json();
      assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
      assert.equal(Object.getPrototypeOf(parsed.usage), Object.prototype);
      assert.deepEqual(parsed, { model: 'example', usage: { cost: 0.01 } });
      assert.equal(item.bodyUsed, true);
      await assert.rejects(item.json(), TypeError);
      assert.throws(() => item.clone(), TypeError);
    }
    assert.equal(mock.calls.length, 1);
  } finally { globalThis.Response = NativeResponse; }
});
