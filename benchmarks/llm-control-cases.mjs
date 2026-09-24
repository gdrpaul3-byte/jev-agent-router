import { createHash } from 'node:crypto';
import { prepareRouteRequest } from '../src/router.mjs';
import { decideRouteBatch } from '../src/router-batch.mjs';

const CONFIG = Object.freeze({ mode: 'shadow', model: 'jev-1.13.0', maxInputBytes: 60000, timeoutMs: 10000, maxCalls: 1 });
const ABSTENTIONS = new Set(['NO_SAFE_ROUTE', 'LOW_CONFIDENCE', 'AMBIGUOUS_ROUTE']);
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  && !['NONE', '__proto__', 'prototype', 'constructor'].includes(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const eligible = routes => routes.filter(route => route.available).map(({ id, description, kind, requiresApproval }) => ({ id, description, kind, requiresApproval }));
function prepare(input) {
  const result = prepareRouteRequest(input, CONFIG);
  if (result.status !== 'prepared') fail('INVALID_COMPARISON_CASES');
  return result;
}
function packetItem(input) {
  const result = prepare(input);
  return { id: result.snapshot.task.id, task: result.snapshot.task, routes: eligible(result.snapshot.routes),
    policy: JSON.parse(result.body).questions.route.instructions };
}

/** Labels and original identities remain evaluator-local, never in a model packet. */
export function prepareComparisonCases(fixtureOrCases) {
  const cases = Array.isArray(fixtureOrCases) ? fixtureOrCases : fixtureOrCases?.cases;
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 12) fail('INVALID_COMPARISON_CASES');
  const ids = new Set(), taskIds = new Set(), scoring = [], inputs = [];
  for (const [index, item] of cases.entries()) {
    if (!fields(item, ['id', 'label', 'input', 'expected']) || !id(item.id) || ids.has(item.id)
        || typeof item.label !== 'string' || !item.label.trim()) fail('INVALID_COMPARISON_CASES');
    const { snapshot } = prepare(item.input);
    if (taskIds.has(snapshot.task.id)) fail('INVALID_COMPARISON_CASES');
    ids.add(item.id); taskIds.add(snapshot.task.id);
    let expected;
    if (fields(item.expected, ['needsHost']) && item.expected.needsHost === true) expected = { needsHost: true };
    else if (fields(item.expected, ['routeId', 'requiresHostApproval']) && id(item.expected.routeId)) {
      const route = snapshot.routes.find(route => route.available && route.id === item.expected.routeId);
      if (!route || item.expected.requiresHostApproval !== route.requiresApproval) fail('INVALID_COMPARISON_CASES');
      expected = { routeId: route.id, requiresHostApproval: route.requiresApproval };
    } else fail('INVALID_COMPARISON_CASES');
    const opaqueId = `t${index}`, routes = eligible(snapshot.routes);
    inputs.push({ task: { ...snapshot.task, id: opaqueId, revision: 1,
      evidence: snapshot.task.evidence.map((item, n) => ({ id: `e${n}`, text: item.text })) },
      routes, baselineRouteId: routes[0].id });
    scoring.push({ opaqueId, originalCaseId: item.id, expected });
  }
  const packet = { tasks: inputs.map(packetItem) };
  return freeze({ packet, inputs, scoring, datasetSha256: hash(cases), packetSha256: hash(packet) });
}

function packetInputs(packet) {
  if (!fields(packet, ['tasks']) || !Array.isArray(packet.tasks) || packet.tasks.length < 1 || packet.tasks.length > 12)
    fail('INVALID_COMPARISON_PACKET');
  return packet.tasks.map((item, index) => {
    if (!fields(item, ['id', 'task', 'routes', 'policy']) || item.id !== `t${index}` || item.task?.id !== item.id
        || item.task?.revision !== 1 || !Array.isArray(item.routes) || !item.routes.length
        || item.routes.some(route => !fields(route, ['id', 'description', 'kind', 'requiresApproval']))) fail('INVALID_COMPARISON_PACKET');
    const input = { task: item.task, routes: item.routes, baselineRouteId: item.routes[0].id };
    const result = prepareRouteRequest(input, CONFIG);
    if (result.status !== 'prepared' || item.policy !== JSON.parse(result.body).questions.route.instructions
        || JSON.stringify(eligible(result.snapshot.routes)) !== JSON.stringify(item.routes)) fail('INVALID_COMPARISON_PACKET');
    return result.snapshot;
  });
}

export async function prepareJevControlRequest(packet) {
  const inputs = packetInputs(packet);
  const result = await decideRouteBatch(inputs, { config: { ...CONFIG, mode: 'dry-run' } });
  if (result.status !== 'dry_run') fail(result.reason === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_COMPARISON_PACKET');
  return Object.freeze({ status: 'prepared', requestBytes: result.requestBytes, requestedModel: CONFIG.model });
}

/** Same production JEV batch path, with billing once for the entire request. */
export async function runJevControl(packet, { apiKey = '', timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
  const started = performance.now(), inputs = packetInputs(packet);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('INVALID_CONFIGURATION');
  const raw = await decideRouteBatch(inputs, { config: { ...CONFIG, timeoutMs }, apiKey, fetchImpl });
  const models = [...new Set(raw.requests.map(row => row.model).filter(Boolean))];
  const observedModel = models.length === 1 ? models[0] : null;
  const decisions = packet.tasks.map((item, index) => {
    if (raw.status === 'decided' && observedModel !== CONFIG.model) return {
      id: item.id, outcome: 'error', routeId: null, requiresHostApproval: null, reason: 'UNEXPECTED_MODEL',
    };
    const selected = raw.status === 'decided' ? raw.decisions[index] : { status: 'needs_host', reason: raw.reason };
    const accepted = selected.status === 'selected';
    return { id: item.id, outcome: accepted ? 'accepted' : ABSTENTIONS.has(selected.reason) ? 'abstained' : 'error',
      routeId: accepted ? selected.routeId : null, requiresHostApproval: accepted ? selected.requiresHostApproval : null,
      reason: accepted ? null : selected.reason };
  });
  return freeze({ decisions, requestedModel: CONFIG.model, observedModel,
    wallLatencyMs: Math.max(0, performance.now() - started), requests: raw.cost.calls,
    usage: { inputTokens: raw.cost.inputTokens, outputTokens: raw.cost.outputTokens,
      cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null },
    cost: { estimatedProviderUsd: raw.cost.estimatedJevUsd, knownUsageUsd: raw.cost.knownUsageUsd,
      cashChargeUsd: null, complete: raw.cost.complete, pricingSource: raw.cost.pricingSource, pricingVerifiedOn: raw.cost.pricingVerifiedOn } });
}
