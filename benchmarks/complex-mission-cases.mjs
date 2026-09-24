// Synthetic development tasks, never a human-validated benchmark or an executor.
// This module is offline: labels stay outside model inputs and scoring is deterministic.
import { prepareRouteRequest } from '../src/router.mjs';

const CANDIDATES = ['c1', 'c2', 'c3'];
const SOURCES = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'];
const REASONS = ['ELIGIBLE', 'MISSING_REQUIRED_DOCUMENT', 'NO_REMAINING_ELIGIBLE_COST',
  'EXCEEDS_OWN_FUNDS', 'MUTUALLY_EXCLUSIVE_LOWER_PRIORITY', 'INELIGIBLE', 'DEADLINE_PASSED'];
const ACTIONS = ['VERIFY_DOCUMENTS', 'PREPARE_DRAFT', 'REQUEST_APPROVAL', 'SUBMIT_APPLICATION'];
const BUDGET_FIELDS = ['eligibleCostWon', 'grantWon', 'ownContributionWon', 'remainingBudgetWon'];
const fail = () => { throw new Error('INVALID_MISSION_FIXTURE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = value => Array.isArray(value) && new Set(value).size === value.length;
const sameSet = (actual, expected) => unique(actual) && actual.length === expected.length && expected.every(item => actual.includes(item));
const includesEvidence = (actual, expected) => unique(actual) && actual.every(id => SOURCES.includes(id)) && expected.every(id => actual.includes(id));
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const enumString = values => ({ type: 'string', enum: values });
const array = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const recordSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// One schema for every mission/variant: no per-case answers or candidate-specific hints.
export const MISSION_SCHEMA = freeze(recordSchema({
  selectedCandidateIds: array(enumString(CANDIDATES), 0, 3),
  candidateDecisions: array(recordSchema({
    candidateId: enumString(CANDIDATES), decision: enumString(['selected', 'excluded', 'needs_info']),
    reasonCodes: array(enumString(REASONS), 1, 3), evidenceIds: array(enumString(SOURCES), 1, 8),
  }), 3, 3),
  budget: recordSchema(Object.fromEntries(BUDGET_FIELDS.map(key => [key, { type: 'integer', minimum: 0 }]))),
  deadlineAt: { type: 'string', minLength: 25, maxLength: 25 },
  nextActions: array(recordSchema({
    step: { type: 'integer', enum: [1, 2, 3, 4] }, actionCode: enumString(ACTIONS),
    targetIds: array(enumString(CANDIDATES), 1, 3), prerequisiteSteps: array({ type: 'integer', enum: [1, 2, 3, 4] }, 0, 3),
    requiresApproval: { type: 'boolean' }, evidenceIds: array(enumString(SOURCES), 1, 8),
  }), 4, 4),
  requiresApproval: { type: 'boolean' },
}));

function validSchema(value, schema) {
  if (schema.type === 'object') return fields(value, schema.required)
    && schema.required.every(key => validSchema(value[key], schema.properties[key]));
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems
    && value.every(item => validSchema(item, schema.items));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? 0)
    && (!schema.enum || schema.enum.includes(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') return typeof value === 'string' && (!schema.enum || schema.enum.includes(value))
    && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
  return false;
}

function validOutput(value) {
  if (!validSchema(value, MISSION_SCHEMA) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value.deadlineAt) || !unique(value.selectedCandidateIds)
      || !sameSet(value.candidateDecisions.map(item => item.candidateId), CANDIDATES)
      || !sameSet(value.nextActions.map(item => item.step), [1, 2, 3, 4])) return false;
  if (!sameSet(value.selectedCandidateIds, value.candidateDecisions.filter(item => item.decision === 'selected').map(item => item.candidateId))) return false;
  if (!value.candidateDecisions.every(item => unique(item.reasonCodes) && unique(item.evidenceIds))) return false;
  return value.nextActions.every(item => unique(item.targetIds) && unique(item.prerequisiteSteps) && unique(item.evidenceIds)
    && item.prerequisiteSteps.every(step => step < item.step));
}

/** Exact fields and arithmetic; required source citations may include other valid eIDs. */
export function scoreMission(value, expected) {
  if (!object(expected) || !validOutput(expected.output)) return { passed: false, corePassed: false, citationPassed: false,
    checksPassed: 0, checksTotal: 1, failures: ['expected.invalid'] };
  const target = expected.output, actual = object(value) ? value : {};
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: passed === true });
  check('structure', validOutput(actual));
  check('selection', sameSet(actual.selectedCandidateIds, target.selectedCandidateIds));
  for (const wanted of target.candidateDecisions) {
    const candidate = Array.isArray(actual.candidateDecisions) ? actual.candidateDecisions.find(item => item?.candidateId === wanted.candidateId) : undefined;
    check(`candidate.${wanted.candidateId}.decision`, candidate?.decision === wanted.decision);
    check(`candidate.${wanted.candidateId}.reasons`, sameSet(candidate?.reasonCodes, wanted.reasonCodes));
    check(`candidate.${wanted.candidateId}.evidence`, includesEvidence(candidate?.evidenceIds, wanted.evidenceIds));
  }
  for (const key of BUDGET_FIELDS) check(`budget.${key}`, actual.budget?.[key] === target.budget[key]);
  check('deadline', actual.deadlineAt === target.deadlineAt);
  for (const wanted of target.nextActions) {
    const action = Array.isArray(actual.nextActions) ? actual.nextActions.find(item => item?.step === wanted.step) : undefined;
    check(`action.${wanted.step}.code`, action?.actionCode === wanted.actionCode);
    check(`action.${wanted.step}.targets`, sameSet(action?.targetIds, wanted.targetIds));
    check(`action.${wanted.step}.prerequisites`, sameSet(action?.prerequisiteSteps, wanted.prerequisiteSteps));
    check(`action.${wanted.step}.approval`, action?.requiresApproval === wanted.requiresApproval);
    check(`action.${wanted.step}.evidence`, includesEvidence(action?.evidenceIds, wanted.evidenceIds));
  }
  check('approval', actual.requiresApproval === target.requiresApproval);
  const failures = checks.filter(item => !item.passed).map(item => item.name);
  return { passed: failures.length === 0,
    corePassed: checks.filter(item => !item.name.endsWith('.evidence')).every(item => item.passed),
    citationPassed: checks.filter(item => item.name.endsWith('.evidence')).every(item => item.passed),
    checksPassed: checks.length - failures.length, checksTotal: checks.length, failures };
}

function validateFixture(fixture) {
  if (!fields(fixture, ['schemaVersion', 'synthetic', 'humanValidated', 'language', 'description', 'common', 'missions'])
      || fixture.schemaVersion !== 1 || fixture.synthetic !== true || fixture.humanValidated !== false || fixture.language !== 'ko'
      || !text(fixture.description) || !fields(fixture.common, ['instructions', 'context'])
      || !text(fixture.common.instructions) || !text(fixture.common.context)
      || !Array.isArray(fixture.missions) || fixture.missions.length !== 2
      || !sameSet(fixture.missions.map(item => item?.id), ['m1', 'm2'])) fail();
  for (const mission of fixture.missions) {
    if (!fields(mission, ['id', 'input', 'sources', 'stages', 'variants'])
        || !fields(mission.input, ['request', 'referenceAt', 'budgetBasis', 'constraints'])
        || !text(mission.input.request) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(mission.input.referenceAt)
        || !['grant_pool', 'own_funds'].includes(mission.input.budgetBasis)
        || !Array.isArray(mission.input.constraints) || !mission.input.constraints.length || !mission.input.constraints.every(text)
        || !Array.isArray(mission.sources) || !sameSet(mission.sources.map(item => item?.id), SOURCES)
        || mission.sources.some(source => !fields(source, ['id', 'summary', 'text']) || !text(source.summary) || !text(source.text))
        || !Array.isArray(mission.stages) || mission.stages.length !== 3
        || !Array.isArray(mission.variants) || mission.variants.length !== 2
        || !sameSet(mission.variants.map(item => item?.variant), ['base', 'changed'])) fail();
    const routeIds = new Set();
    for (const stage of mission.stages) {
      if (!fields(stage, ['request', 'routes']) || !text(stage.request) || !Array.isArray(stage.routes) || stage.routes.length !== 2) fail();
      for (const route of stage.routes) {
        if (!fields(route, ['id', 'description', 'sourceIds']) || !/^r[1-6]$/.test(route.id) || routeIds.has(route.id)
            || !text(route.description) || !unique(route.sourceIds) || !route.sourceIds.length || route.sourceIds.some(id => !SOURCES.includes(id))) fail();
        routeIds.add(route.id);
      }
    }
    for (const variant of mission.variants) {
      if (!fields(variant, ['variant', 'sourceOverrides', 'expected']) || !object(variant.sourceOverrides)
          || (variant.variant === 'base' && Object.keys(variant.sourceOverrides).length !== 0)
          || (variant.variant === 'changed' && !sameSet(Object.keys(variant.sourceOverrides), ['e4']))
          || Object.entries(variant.sourceOverrides).some(([id, source]) => !SOURCES.includes(id)
            || !fields(source, ['summary', 'text']) || !text(source.summary) || !text(source.text))
          || !fields(variant.expected, ['output', 'routing']) || !validOutput(variant.expected.output)
          || !Array.isArray(variant.expected.routing) || variant.expected.routing.length !== 3) fail();
      const recovered = [];
      variant.expected.routing.forEach((expected, index) => {
        if (!fields(expected, ['routeId', 'requiresHostApproval']) || expected.requiresHostApproval !== false) fail();
        const route = mission.stages[index].routes.find(route => route.id === expected.routeId);
        if (!route) fail();
        recovered.push(...route.sourceIds);
      });
      if (!sameSet(recovered, SOURCES)) fail();
    }
  }
}

/** Local answer key remains alongside, never inside mission or routing payloads. */
export function buildMissionCases(fixture) {
  try { validateFixture(fixture); } catch { fail(); }
  const results = [];
  for (const id of ['m1', 'm2']) {
    const definition = fixture.missions.find(item => item.id === id);
    for (const variant of ['base', 'changed']) {
      const version = definition.variants.find(item => item.variant === variant);
      const sources = definition.sources.map(source => ({ ...source, ...(version.sourceOverrides[source.id] ?? {}) }));
      const sourceById = new Map(sources.map(source => [source.id, source]));
      const toolOutputs = {};
      const routingInputs = definition.stages.map((stage, index) => {
        const sourceIds = [...new Set(stage.routes.flatMap(route => route.sourceIds))];
        const routes = stage.routes.map(route => {
          toolOutputs[route.id] = { id: `b${route.id.slice(1)}`, text: JSON.stringify({ sources: route.sourceIds.map(id => ({ id, text: sourceById.get(id).text })) }) };
          return { id: route.id, description: route.description, available: true, kind: 'read', requiresApproval: false };
        });
        const input = { task: { id: `t${index}`, revision: 1,
          request: stage.request, progress: '가상의 내부 업무다. 선택은 로컬 자료 회수 권고이며 외부 작업은 실행하지 않는다.',
          evidence: sourceIds.map(id => ({ id, text: sourceById.get(id).summary })) }, routes, baselineRouteId: routes[0].id };
        if (prepareRouteRequest(input, { maxInputBytes: 60000 }).status !== 'prepared') fail();
        return input;
      });
      results.push({ id, variant, mission: { instructions: fixture.common.instructions, context: fixture.common.context,
        input: structuredClone(definition.input), schema: MISSION_SCHEMA }, routingInputs, toolOutputs, expected: structuredClone(version.expected) });
    }
  }
  return freeze(results);
}
