import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareRouteRequest } from '../src/router.mjs';

async function subject() {
  try { return await import('../benchmarks/complex-mission-cases.mjs'); }
  catch { assert.fail('Complex mission builder and deterministic scorer must exist'); }
}
async function fixture() { return JSON.parse(await readFile(new URL('../benchmarks/complex-missions.json', import.meta.url), 'utf8')); }
async function cases() { return (await subject()).buildMissionCases(await fixture()); }

test('four local synthetic cases separate model input from evaluator-only answers and labels', async () => {
  const built = await cases();
  assert.equal(built.length, 4);
  assert.deepEqual(built.map(item => [item.id, item.variant]), [['m1', 'base'], ['m1', 'changed'], ['m2', 'base'], ['m2', 'changed']]);
  for (const item of built) {
    assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.expected.output));
    assert.equal(item.routingInputs.length, 3);
    assert.equal(item.expected.routing.length, 3);
    const wire = JSON.stringify({ mission: item.mission, routingInputs: item.routingInputs, toolOutputs: item.toolOutputs });
    for (const field of ['"expected"', '"variant"', '"label"', '"humanValidated"']) assert.ok(!wire.includes(field));
    assert.ok(!wire.includes(`"${item.id}"`));
    assert.equal(Object.hasOwn(item.mission.input, 'sources'), false);
    assert.equal(Object.hasOwn(item.mission.input, 'evidence'), false);
    assert.ok(item.mission.instructions.includes('가상'));
    assert.ok(item.mission.context.includes('실행'));
  }
});

test('all variants share exact schema and common instruction prefix while decisive evidence changes', async () => {
  const built = await cases();
  const prefix = item => JSON.stringify([item.mission.instructions, item.mission.context, item.mission.schema]);
  assert.equal(new Set(built.map(prefix)).size, 1);
  for (let index = 0; index < built.length; index += 2) {
    const base = built[index], changed = built[index + 1];
    assert.deepEqual(base.mission, changed.mission);
    assert.notDeepEqual(base.routingInputs, changed.routingInputs);
    assert.notDeepEqual(base.toolOutputs, changed.toolOutputs);
    assert.notDeepEqual(base.expected.output, changed.expected.output);
    assert.equal(base.routingInputs[1].task.id, changed.routingInputs[1].task.id);
  }
});

test('every mission schema prepares through the real structured adapter without credentials or network', async () => {
  const { prepareStructuredRequest } = await import('../src/structured-llm.mjs');
  for (const item of await cases()) {
    const prepared = prepareStructuredRequest({ ...item.mission, model: 'openai/gpt-6-astra' });
    assert.equal(prepared.status, 'prepared');
  }
});

test('three valid route inputs retrieve eight independently identified local source documents', async () => {
  for (const item of await cases()) {
    const recovered = [];
    for (const [index, input] of item.routingInputs.entries()) {
      assert.equal(input.task.id, `t${index}`);
      assert.equal(prepareRouteRequest(input, { maxInputBytes: 60000 }).status, 'prepared');
      for (const route of input.routes) {
        assert.equal(route.kind, 'read'); assert.equal(route.requiresApproval, false);
        assert.ok(item.toolOutputs[route.id]);
      }
      const expected = item.expected.routing[index];
      assert.equal(expected.requiresHostApproval, false);
      const bundle = JSON.parse(item.toolOutputs[expected.routeId].text);
      recovered.push(...bundle.sources.map(source => source.id));
      for (const source of input.task.evidence) assert.match(source.id, /^e[1-8]$/);
    }
    assert.deepEqual(recovered.sort(), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
  }
});

test('frozen scholarship labels calculate caps, existing aid and changed fully funded candidate', async () => {
  const [base, changed] = await cases();
  assert.deepEqual(base.expected.output.selectedCandidateIds, ['c1', 'c2']);
  assert.deepEqual(base.expected.output.budget, { eligibleCostWon: 2800000, grantWon: 2700000, ownContributionWon: 100000, remainingBudgetWon: 100000 });
  assert.deepEqual(changed.expected.output.selectedCandidateIds, ['c1']);
  assert.deepEqual(changed.expected.output.budget, { eligibleCostWon: 1600000, grantWon: 1500000, ownContributionWon: 100000, remainingBudgetWon: 1300000 });
  assert.equal(changed.expected.output.candidateDecisions.find(item => item.candidateId === 'c2').reasonCodes[0], 'NO_REMAINING_ELIGIBLE_COST');
  assert.equal(base.expected.output.deadlineAt, '2026-09-28T15:00:00+09:00');
});

test('frozen grant labels combine VAT, cap, duplicate-project constraint and changed quote', async () => {
  const [, , base, changed] = await cases();
  assert.deepEqual(base.expected.output.selectedCandidateIds, ['c1']);
  assert.deepEqual(base.expected.output.budget, { eligibleCostWon: 6000000, grantWon: 4800000, ownContributionWon: 1800000, remainingBudgetWon: 600000 });
  assert.deepEqual(changed.expected.output.selectedCandidateIds, ['c2']);
  assert.deepEqual(changed.expected.output.budget, { eligibleCostWon: 4000000, grantWon: 2400000, ownContributionWon: 2000000, remainingBudgetWon: 400000 });
  assert.equal(changed.expected.output.candidateDecisions.find(item => item.candidateId === 'c1').reasonCodes[0], 'EXCEEDS_OWN_FUNDS');
  assert.equal(changed.expected.output.deadlineAt, '2026-09-27T18:00:00+09:00');
});

test('deterministic scoring accepts equivalent ordering and required evidence with valid extra references', async () => {
  const { scoreMission } = await subject();
  for (const item of await cases()) {
    const value = structuredClone(item.expected.output);
    value.candidateDecisions.reverse(); value.nextActions.reverse(); value.selectedCandidateIds.reverse();
    value.candidateDecisions[0].evidenceIds.push('e8');
    const result = scoreMission(value, item.expected);
    assert.equal(result.passed, true); assert.equal(result.checksPassed, result.checksTotal); assert.deepEqual(result.failures, []);
  }
});

test('scoring rejects stale answers, wrong math, missing citations and unsafe execution plans', async () => {
  const { scoreMission } = await subject(), built = await cases();
  for (const index of [0, 2]) assert.equal(scoreMission(built[index].expected.output, built[index + 1].expected).passed, false);
  const original = built[0];
  for (const mutate of [
    value => { value.budget.grantWon += 1; },
    value => { value.candidateDecisions[0].evidenceIds = []; },
    value => { value.nextActions[3].requiresApproval = false; },
    value => { value.nextActions[3].prerequisiteSteps = []; },
    value => { value.candidateDecisions[2].decision = 'selected'; },
    value => { value.deadlineAt = '2026-09-25T17:00:00+09:00'; },
    value => { value.nextActions[0].targetIds = ['c1']; },
    value => { value.requiresApproval = false; },
    value => { value.candidateDecisions[0].evidenceIds.push('SECRET_PROVIDER_TEXT'); },
  ]) {
    const value = structuredClone(original.expected.output); mutate(value);
    const result = scoreMission(value, original.expected);
    assert.equal(result.passed, false); assert.ok(result.checksPassed < result.checksTotal);
    assert.ok(result.failures.every(name => /^[a-zA-Z0-9_.-]+$/.test(name)));
    assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_TEXT'));
  }
});

test('citation-only errors stay strictly failed while core arithmetic and approval checks remain separate', async () => {
  const { scoreMission } = await subject(), item = (await cases())[0];
  const value = structuredClone(item.expected.output);
  value.candidateDecisions.find(candidate => candidate.candidateId === 'c3').evidenceIds = ['e8'];
  const citationFailure = scoreMission(value, item.expected);
  assert.equal(citationFailure.passed, false); assert.equal(citationFailure.corePassed, true); assert.equal(citationFailure.citationPassed, false);
  const math = structuredClone(item.expected.output); math.budget.grantWon += 1;
  const coreFailure = scoreMission(math, item.expected);
  assert.equal(coreFailure.passed, false); assert.equal(coreFailure.corePassed, false); assert.equal(coreFailure.citationPassed, true);
});

test('duplicate keys-by-id, extra fields, wrong types and malformed results never pass', async () => {
  const { scoreMission } = await subject(), item = (await cases())[0];
  for (const value of [null, [], 'PRIVATE_RESULT', { ...item.expected.output, explanation: 'PRIVATE_RESULT' },
    { ...item.expected.output, candidateDecisions: [item.expected.output.candidateDecisions[0], item.expected.output.candidateDecisions[0], item.expected.output.candidateDecisions[2]] },
    { ...item.expected.output, budget: { ...item.expected.output.budget, grantWon: '2700000' } }]) {
    const result = scoreMission(value, item.expected); assert.equal(result.passed, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_RESULT'));
  }
});

test('builder rejects untrusted fixture shape, unsupported labels and source references without mutation', async () => {
  const { buildMissionCases } = await subject(), original = await fixture(), before = JSON.stringify(original);
  buildMissionCases(original); assert.equal(JSON.stringify(original), before);
  for (const mutate of [
    value => { value.synthetic = false; },
    value => { value.humanValidated = true; },
    value => { value.missions[0].stages[0].routes[0].sourceIds = ['e9']; },
    value => { value.missions[0].variants[0].expected.output.budget.grantWon = -1; },
    value => { value.missions[0].variants[0].expected.routing[0].routeId = 'missing'; },
    value => { value.missions[0].variants[1].sourceOverrides.e9 = { summary: 'x', text: 'x' }; },
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => buildMissionCases(value), /^Error: INVALID_MISSION_FIXTURE$/);
  }
});
