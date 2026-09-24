import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as router from '../src/router-task.mjs';

const input = (revision = 1) => ({ task: { id: 'handoff-test', revision, request: 'Draft using the supplied facts.', evidence: [{ id: 's1', text: 'PRIVATE_TASK_FACT' }] },
  routes: [{ id: 'draft', description: 'Make a local draft', kind: 'draft' }, { id: 'send', description: 'Send externally', kind: 'write' }], baselineRouteId: 'draft' });
const response = (choice = 'draft') => Response.json({ model: 'jev-1.13.0', answers: { route: { type: 'choice', choice, confidence: .98,
  probabilities: { draft: choice === 'draft' ? .98 : .01, send: choice === 'send' ? .98 : .01, NONE: .01 } } }, usage: { input_tokens: 200, output_tokens: 0 } });
async function setup(t, mode = 'active', choice = 'draft') {
  const root = await mkdtemp(join(tmpdir(), 'jev-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), config: { mode } };
  const result = await router.runRoutingTask(input(), { ...options, apiKey: 'synthetic-key', fetchImpl: async () => response(choice) });
  return { options, result, root };
}
async function readReady(...args) {
  assert.equal(typeof router.readReadyHandoff, 'function', 'offline reader must be exported');
  return router.readReadyHandoff(...args);
}
async function snapshotFiles(root) {
  const names = (await readdir(root, { recursive: true, withFileTypes: true })).filter(item => item.isFile());
  const data = [];
  for (const file of names) {
    const path = join(file.parentPath, file.name);
    data.push({ path, content: await readFile(path, 'utf8'), modified: (await stat(path)).mtimeMs });
  }
  return data.sort((a,b) => a.path.localeCompare(b.path));
}

test('offline handoff reader returns canonical immutable packet, no state mutation or new billing', async t => {
  const { options } = await setup(t), before = await snapshotFiles(options.stateDir);
  const result = await readReady(input(), options);
  assert.equal(result.status, 'handoff_ready'); assert.equal(result.cost.calls, 0); assert.deepEqual(result.requests, []);
  assert.equal(result.decisionCost.inputTokens, 200); assert.equal(result.decisionRequests.length, 1);
  assert.equal(result.handoff.route.id, 'draft'); assert.equal(result.executionClaimed, false);
  assert.equal(result.requiresFreshHostValidation, true); assert.equal(result.replayed, true);
  assert.ok(Object.isFrozen(result.handoff.task.evidence[0]));
  assert.throws(() => { result.handoff.task.evidence[0].text = 'modified'; }, TypeError);
  assert.deepEqual(await snapshotFiles(options.stateDir), before);
});

test('missing state and handoff never create or repair files', async t => {
  const { root, options, result } = await setup(t);
  const missingDir = join(root, 'absent');
  assert.equal((await readReady(input(), { ...options, stateDir: missingDir })).reason, 'TASK_NOT_FOUND');
  await assert.rejects(stat(missingDir));
  await rm(result.handoffPath);
  assert.equal((await readReady(input(), options)).reason, 'HANDOFF_NOT_FOUND');
  await assert.rejects(stat(result.handoffPath));
});

test('requires explicit enabled active mode and a state directory', async () => {
  for (const config of [{}, {mode:'shadow'}, {mode:'dry-run'}, {mode:'active',enabled:false}]) {
    assert.equal((await readReady(input(), { config })).reason, 'HANDOFF_REQUIRES_ACTIVE');
  }
  assert.equal((await readReady(input(), {config:{mode:'active'}})).reason, 'STATE_DIR_REQUIRED');
  assert.equal((await readReady({ sensitive: 'PRIVATE_TASK_FACT' }, {})).reason, 'INVALID_INPUT');
});

test('current task and settings must match the saved decision exactly', async t => {
  const { options } = await setup(t);
  for (const change of [x=>{x.task.request='Different goal';},x=>{x.task.evidence[0].text='Changed fact';},x=>{x.routes[0].description='New capability';},x=>{x.routes[1].available=false;}]) {
    const changed = input(); change(changed);
    assert.equal((await readReady(changed, options)).reason, 'TASK_REVISION_CONFLICT');
  }
  assert.equal((await readReady(input(2), options)).reason, 'TASK_NOT_FOUND');
  assert.equal((await readReady(input(), {...options,config:{mode:'active',maxCalls:50}})).reason, 'TASK_REVISION_CONFLICT');
});

test('a known newer task revision makes an older ready handoff stale', async t => {
  const { options } = await setup(t);
  const next = input(2); next.task.evidence[0].text = 'Newer confirmed fact';
  const created = await router.runRoutingTask(next, { ...options, apiKey: 'synthetic-key', fetchImpl: async () => response() });
  assert.equal(created.status, 'ready');
  assert.equal((await readReady(input(), options)).reason, 'STALE_TASK_REVISION');
  assert.equal((await readReady(next, options)).status, 'handoff_ready');
});

test('pending and approval-required decisions have no consumable ready handoff', async t => {
  const { options } = await setup(t);
  const path = join(options.stateDir, 'state.json'), state = JSON.parse(await readFile(path,'utf8'));
  const job = Object.values(state.jobs)[0]; job.state = 'pending'; delete job.result; delete job.handoff;
  await writeFile(path, JSON.stringify(state));
  assert.equal((await readReady(input(), options)).reason, 'TASK_OUTCOME_UNKNOWN');
  const other = await setup(t, 'active', 'send');
  assert.equal((await readReady(input(), other.options)).reason, 'HANDOFF_NOT_READY');
  const shadow = await setup(t, 'shadow');
  assert.equal((await readReady(input(), {...shadow.options,config:{mode:'active'}})).reason, 'TASK_NOT_FOUND');
});

test('hand-written or corrupt state and modified handoff fail closed without data disclosure', async t => {
  const { options, result } = await setup(t);
  await writeFile(result.handoffPath, '{"PRIVATE_TASK_FACT":"forged"}');
  const changed = await readReady(input(), options);
  assert.equal(changed.reason, 'HANDOFF_MISMATCH'); assert.doesNotMatch(JSON.stringify(changed), /PRIVATE_TASK_FACT|synthetic-key/);
  const path = join(options.stateDir, 'state.json'), state = JSON.parse(await readFile(path,'utf8'));
  Object.values(state.jobs)[0].fingerprint = 'forged'; await writeFile(path, JSON.stringify(state));
  assert.equal((await readReady(input(), options)).reason, 'STATE_INVALID');
});

test('reader respects an existing writer lock without changing it', async t => {
  const { options } = await setup(t);
  await writeFile(join(options.stateDir,'.lock'),'test-writer');
  assert.equal((await readReady(input(), options)).reason, 'STATE_BUSY');
  assert.equal(await readFile(join(options.stateDir,'.lock'),'utf8'),'test-writer');
});

test('concurrent reads are verification only and do not claim a worker execution', async t => {
  const { options } = await setup(t);
  const results = await Promise.all([readReady(input(),options),readReady(input(),options)]);
  for (const result of results) { assert.equal(result.status,'handoff_ready'); assert.equal(result.executionClaimed,false); }
  assert.deepEqual(results[0].handoff, results[1].handoff);
});

test('invalid handoff directory object is rejected instead of traversed', async t => {
  const { options, result } = await setup(t);
  await rm(result.handoffPath); await rmdir(join(options.stateDir,'handoffs'));
  await writeFile(join(options.stateDir,'handoffs'),'not a directory');
  assert.equal((await readReady(input(),options)).reason,'HANDOFF_MISMATCH');
});
