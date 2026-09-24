// HTTPS fetch adapter for an existing Node host that did not start with --use-system-ca.
// Uses the default + OS trust stores without weakening certificate/hostname verification.
import { request as httpsRequest } from 'node:https';
import { getCACertificates as nodeCertificates, checkServerIdentity } from 'node:tls';

const POST_ENDPOINTS = new Set([
  'https://openrouter.ai/api/v1/chat/completions',
  'https://api.typesafe.ai/v1/systemone',
]);
const HEAD_ENDPOINTS = new Set([...POST_ENDPOINTS, 'https://openrouter.ai/api/v1/models']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const error = code => new Error(code);
const aborted = () => Object.assign(error('REQUEST_ABORTED'), { name: 'AbortError' });

// Some embedded hosts expose a Response constructor from a different JS realm.
// Its native json() then returns foreign-prototype objects, which our strict input
// validators intentionally reject. Parse response text in this module's realm;
// keep native body consumption/clone semantics and apply the same boundary to clones.
function localJsonResponse(response) {
  const originalClone = response.clone;
  Object.defineProperties(response, {
    json: { configurable: true, writable: true, value: async function json() {
      return JSON.parse(await this.text());
    } },
    clone: { configurable: true, writable: true, value: function clone() {
      return localJsonResponse(Reflect.apply(originalClone, this, []));
    } },
  });
  return response;
}

/**
 * The caller must supply an AbortSignal with its own deadline. This adapter never retries.
 * Test seams are trusted host functions, not task/model options. No proxy, agent or URL
 * overrides are exposed. Returned responses are fully buffered and capped at 2 MiB.
 */
export function createSystemCaFetch({ requestImpl = httpsRequest, getCACertificates = nodeCertificates } = {}) {
  if (typeof requestImpl !== 'function' || typeof getCACertificates !== 'function') throw error('INVALID_FETCH_CONFIGURATION');
  let certificates;
  try {
    const defaults = getCACertificates('default'), system = getCACertificates('system');
    if (![defaults, system].every(items => Array.isArray(items) && items.every(item => typeof item === 'string' && item.length > 0))) throw error('INVALID_CA');
    certificates = [...new Set([...defaults, ...system])];
    if (!certificates.length) throw error('EMPTY_CA');
  } catch { throw error('SYSTEM_CA_UNAVAILABLE'); }

  return async function systemCaFetch(input, init = {}) {
    let url, method, body, headers, signal;
    try {
      // Exact text matching avoids accepting alternate hosts, credentials, ports or paths.
      const value = input instanceof URL ? input.href : input;
      method = init.method ?? 'GET';
      if (typeof value !== 'string' || !['POST', 'HEAD'].includes(method)
          || !(method === 'POST' ? POST_ENDPOINTS : HEAD_ENDPOINTS).has(value)
          || (init.redirect !== undefined && init.redirect !== 'error')) throw error('INVALID');
      url = new URL(value);
      signal = init.signal;
      if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function') throw error('INVALID');
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) throw error('INVALID');
      body = init.body === undefined || init.body === null ? null : Buffer.from(init.body);
      if ((method === 'HEAD' && body !== null) || (body && body.length > MAX_REQUEST_BYTES)) throw error('INVALID');
      headers = new Headers(init.headers);
      for (const name of ['host', 'connection', 'transfer-encoding', 'content-length', 'expect', 'upgrade']) {
        if (headers.has(name)) throw error('INVALID');
      }
      headers.set('accept-encoding', 'identity');
      if (body !== null) headers.set('content-length', String(body.length));
    } catch { throw error('INVALID_FETCH_REQUEST'); }
    if (signal.aborted) throw aborted();

    return new Promise((resolve, reject) => {
      let request, response, settled = false;
      const finish = (failure, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (failure) {
          // Do not forward native errors: they can contain URLs, paths or header values.
          reject(failure);
          try { response?.destroy(); } catch { /* already closed */ }
          try { request?.destroy(); } catch { /* already closed */ }
        } else resolve(value);
      };
      const onAbort = () => finish(aborted());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { finish(aborted()); return; }
      try {
        request = requestImpl(url, {
          method, headers: Object.fromEntries(headers),
          ca: [...certificates], rejectUnauthorized: true, checkServerIdentity,
          servername: url.hostname, agent: false,
        }, incoming => {
          response = incoming;
          // Always attach error handlers, including to a response arriving after an abort.
          incoming.on('error', () => finish(error('HTTPS_RESPONSE_FAILED')));
          incoming.on('aborted', () => finish(error('HTTPS_RESPONSE_FAILED')));
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode;
          if (!Number.isInteger(status) || status < 200 || status > 599) { finish(error('INVALID_HTTPS_RESPONSE')); return; }
          if (status >= 300 && status < 400) { finish(error('HTTPS_REDIRECT_REJECTED')); return; }
          const encoding = incoming.headers?.['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') { finish(error('UNSUPPORTED_RESPONSE_ENCODING')); return; }
          const declaredLength = incoming.headers?.['content-length'];
          // HEAD may describe a large representation without transferring any body.
          if (method !== 'HEAD' && declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
            finish(error('RESPONSE_TOO_LARGE')); return;
          }
          const chunks = []; let length = 0, ended = false;
          incoming.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length > MAX_RESPONSE_BYTES) { finish(error('RESPONSE_TOO_LARGE')); return; }
            chunks.push(bytes);
          });
          incoming.on('end', () => {
            ended = true;
            if (settled) return;
            try {
              const responseHeaders = new Headers();
              for (const [name, values] of Object.entries(incoming.headers ?? {})) {
                if (values === undefined) continue;
                for (const value of Array.isArray(values) ? values : [values]) responseHeaders.append(name, value);
              }
              const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
              finish(null, localJsonResponse(new Response(noBody ? null : Buffer.concat(chunks, length), { status, headers: responseHeaders })));
            } catch { finish(error('INVALID_HTTPS_RESPONSE')); }
          });
          incoming.on('close', () => { if (!ended) finish(error('HTTPS_RESPONSE_FAILED')); });
        });
        request.on('error', () => finish(error('HTTPS_REQUEST_FAILED')));
        // An injected/synchronous host may abort while creating the request.
        if (settled) { request.destroy(); return; }
        request.end(body ?? undefined);
      } catch { finish(error('HTTPS_REQUEST_FAILED')); }
    });
  };
}
