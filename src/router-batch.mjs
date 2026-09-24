import { prepareRouteRequest, validateRouteAnswer } from './router.mjs';
import { createMeteredFetch, summarizeBilling } from './meter.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_TASKS = 16;
const now = () => globalThis.performance?.now() ?? Date.now();
const bytes = value => new TextEncoder().encode(value).byteLength;

function dataRecord(value, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) || !Object.hasOwn(descriptors[key], 'value')) return null;
    result[key] = descriptors[key].value;
  }
  return result;
}

function inputArray(value) {
  if (!Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_TASKS || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const copied = [];
  for (let i = 0; i < length; i++) {
    if (!descriptors[i] || !Object.hasOwn(descriptors[i], 'value')) return null;
    copied.push(descriptors[i].value);
  }
  return copied;
}

function prepareBatch(inputs, config) {
  const source = inputArray(inputs);
  if (!source) return { reason: 'INVALID_INPUT' };
  const prepared = [], taskIds = new Set();
  for (const input of source) {
    const item = prepareRouteRequest(input, config);
    if (item.status !== 'prepared') return { reason: item.reason };
    if (item.config.mode === 'active') return { reason: 'INVALID_CONFIGURATION' };
    if (taskIds.has(item.snapshot.task.id)) return { reason: 'INVALID_INPUT' };
    taskIds.add(item.snapshot.task.id); prepared.push(item);
  }
  const tasks = {}, questions = {};
  for (const [index, item] of prepared.entries()) {
    const key = `t${index}`;
    tasks[key] = item.snapshot.task;
    const question = JSON.parse(item.body).questions.route;
    questions[key] = {
      ...question,
      instructions: `For this independent question, use only state.tasks.${key} as the task, progress and evidence. Ignore every other state.tasks entry and every other question's route choices. Never borrow facts, instructions or permissions from another task. ${question.instructions}`,
    };
  }
  const normalizedConfig = prepared[0].config;
  const body = JSON.stringify({ model: normalizedConfig.model, state: { tasks }, questions });
  if (bytes(body) > normalizedConfig.maxInputBytes) return { reason: 'INPUT_TOO_LARGE' };
  return { prepared: Object.freeze(prepared), config: normalizedConfig, body, keys: Object.freeze(Object.keys(questions)) };
}

function validateEnvelope(value, keys) {
  const body = dataRecord(value);
  if (!body) return null;
  const answers = dataRecord(body.answers, keys);
  if (!answers) return null;
  // Reuse the canonical model/usage validation without accepting any task answer.
  const sentinel = { type: 'choice', choice: 'probe', confidence: 1, probabilities: { probe: 1, NONE: 0 } };
  if (!validateRouteAnswer({ model: body.model, usage: body.usage, answers: { route: sentinel } }, ['probe'])) return null;
  return { model: body.model, usage: body.usage, answers };
}

function decideItem(item, envelope, answer) {
  const identity = { taskId: item.snapshot.task.id, revision: item.snapshot.task.revision };
  let validated;
  try {
    validated = validateRouteAnswer({ model: envelope.model, usage: envelope.usage, answers: { route: answer } }, item.eligibleRouteIds);
  } catch { /* A malformed item cannot invalidate a separate valid task answer. */ }
  if (!validated) return { ...identity, status: 'needs_host', reason: 'INVALID_RESPONSE' };
  const metrics = { confidence: validated.confidence, margin: validated.margin };
  let reason;
  if (validated.routeId === 'NONE') reason = 'NO_SAFE_ROUTE';
  else if (validated.confidence < item.config.minConfidence) reason = 'LOW_CONFIDENCE';
  else if (validated.margin < item.config.minMargin) reason = 'AMBIGUOUS_ROUTE';
  if (reason) return { ...identity, status: 'needs_host', reason, ...metrics };
  const route = item.snapshot.routes.find(route => route.id === validated.routeId);
  return { ...identity, status: 'selected', routeId: route.id, requiresHostApproval: route.requiresApproval, ...metrics, model: validated.model };
}

/**
 * Preview independent routing questions in one paid request. This has no durable
 * replay/budget state, handoff or worker execution. maxCalls=0 disables dispatch;
 * positive maxCalls does not create a cross-invocation budget.
 * latencyMs is the aggregate elapsed time through validation, response parsing
 * and bounded billing settlement. It is not completed-workflow latency. Usage
 * belongs to the whole request and is never divided into invented per-item costs.
 */
export async function decideRouteBatch(inputs, options = {}) {
  const started = now();
  let meter = createMeteredFetch({ fetchImpl: async () => { throw new Error('UNREACHABLE'); } });
  let mode = 'shadow';
  const finish = outcome => ({ ...outcome, mode, previewOnly: true, latencyMs: Math.max(0, now() - started),
    cost: summarizeBilling(meter.stats()), requests: meter.records() });
  const needsHost = reason => finish({ status: 'needs_host', reason });
  let settings, batch;
  try {
    settings = dataRecord(options, ['config', 'apiKey', 'fetchImpl']);
    if (!settings) return needsHost('INVALID_CONFIGURATION');
    batch = prepareBatch(inputs, Object.hasOwn(settings, 'config') ? settings.config : {});
  } catch { return needsHost('INVALID_INPUT'); }
  if (batch.reason) return needsHost(batch.reason);
  const { prepared, config, body, keys } = batch;
  mode = config.mode;
  if (!config.enabled) return finish({ status: 'bypassed', decisions: prepared.map(item => {
    const route = item.snapshot.routes.find(route => route.id === item.snapshot.baselineRouteId);
    return { taskId: item.snapshot.task.id, revision: item.snapshot.task.revision,
      status: 'bypassed', routeId: route.id, requiresHostApproval: route.requiresApproval };
  }) });
  if (mode === 'dry-run') return finish({ status: 'dry_run', requestBytes: bytes(body), tasks: prepared.map(item => ({
    taskId: item.snapshot.task.id, revision: item.snapshot.task.revision, eligibleRouteIds: item.eligibleRouteIds,
  })) });
  if (config.maxCalls === 0) return needsHost('CALL_BUDGET_EXHAUSTED');
  const apiKey = Object.hasOwn(settings, 'apiKey') ? settings.apiKey : '';
  const fetchImpl = Object.hasOwn(settings, 'fetchImpl') ? settings.fetchImpl : globalThis.fetch;
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey) || typeof fetchImpl !== 'function') return needsHost('INVALID_CONFIGURATION');
  if (!apiKey.trim()) return needsHost('MISSING_API_KEY');
  meter = createMeteredFetch({ fetchImpl });
  let timer, outcome;
  const requestDeadline = now() + config.timeoutMs;
  try {
    const controller = new AbortController();
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { resolve({ reason: 'TIMEOUT' }); controller.abort(); }, config.timeoutMs);
    });
    const request = (async () => {
      const response = await meter.fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        body, signal: controller.signal,
      });
      if (!response || typeof response.ok !== 'boolean') return { reason: 'INVALID_RESPONSE' };
      if (!response.ok) return { reason: 'HTTP_ERROR' };
      if (typeof response.json !== 'function') return { reason: 'INVALID_RESPONSE' };
      return { body: await response.json() };
    })();
    const response = await Promise.race([request, deadline]);
    if (response.reason) outcome = { status: 'needs_host', reason: response.reason };
    else {
      const envelope = validateEnvelope(response.body, keys);
      outcome = !envelope ? { status: 'needs_host', reason: 'INVALID_RESPONSE' }
        : { status: 'decided', decisions: prepared.map((item, index) => decideItem(item, envelope, envelope.answers[keys[index]])) };
    }
  } catch {
    outcome = { status: 'needs_host', reason: 'REQUEST_FAILED' };
  } finally {
    clearTimeout(timer);
  }
  // Cloning for usage can still be pending. Do not extend the request's timeout
  // to wait for a hung billing clone, and snapshot unknown costs instead of zero.
  await meter.flush({ timeoutMs: Math.max(0, requestDeadline - now()) });
  return finish(outcome);
}
