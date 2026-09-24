import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

async function subject() { return import('../benchmarks/live-demo-server.mjs'); }
async function temporary(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'jev-live-demo-test-'));
  t.after(async () => {
    const target = resolve(directory); assert.ok(target.startsWith(parent + sep));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return directory;
}
function child() { const process = new EventEmitter(); process.kill = () => { process.emit('exit', null, 'SIGTERM'); return true; }; return process; }

test('read-only local dashboard never starts paid work from HTTP and exposes no environment paths', async t => {
  const { createLiveDemoServer } = await subject(); const root = await temporary(t); let calls = 0;
  const server = await createLiveDemoServer({ runId: 'test-a', envFile: join(root, 'SECRET.env'), artifactRoot: root, port: 0,
    spawnImpl: () => { calls++; return child(); } });
  t.after(() => server.close());
  const page = await fetch(server.url); assert.equal(page.status, 200);
  assert.match(await page.text(), /LIVE TASK COMPARISON/);
  const state = await (await fetch(server.url + 'api/status')).json();
  assert.equal(state.status, 'idle'); assert.equal(state.completedWorkflows, 0); assert.equal(state.totalCalls, 0);
  assert.ok(!JSON.stringify(state).includes('SECRET'));
  for (const route of ['run', 'api/run', 'api/status']) assert.equal((await fetch(server.url + route, { method: 'POST' })).status, 405);
  const hostileHostStatus = await new Promise((done, reject) => {
    const request = httpRequest(server.url + 'api/status', { headers: { Host: 'evil.example' } }, response => { response.resume(); done(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(server.url + '.env')).status, 404); assert.equal(calls, 0);
});

test('explicit host start launches one fixed evaluator without shell and preserves atomic checkpoint progress', async t => {
  const { createLiveDemoServer } = await subject(), root = await temporary(t); const spawned = [], proc = child();
  const server = await createLiveDemoServer({ runId: 'test-b', envFile: join(root, 'keys.env'), artifactRoot: root, port: 0,
    spawnImpl: (...args) => { spawned.push(args); return proc; } });
  t.after(() => server.close());
  await server.startRun(); await assert.rejects(server.startRun(), /RUN_ALREADY_STARTED/);
  assert.equal(spawned.length, 1); const [binary, args, options] = spawned[0];
  assert.equal(binary, process.execPath); assert.ok(args.includes('--use-system-ca'));
  assert.ok(args.some(value => value.endsWith('complex-mission-eval.mjs')));
  assert.deepEqual(args.slice(-4), ['--budget-usd', '5', '--max-requests', '80']);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(server.outputPath, join(root, 'live-demo-test-b', 'report.json'));
  const fixture = JSON.parse(await readFile(new URL('../benchmarks/results/complex-missions-v1/report.json', import.meta.url), 'utf8'));
  await mkdir(join(root, 'live-demo-test-b'), { recursive: true });
  const progress = { ...fixture, status: 'running', runs: fixture.runs.slice(0, 1) };
  await writeFile(server.outputPath, JSON.stringify(progress));
  const view = await server.getState();
  assert.equal(view.completedWorkflows, 1); assert.equal(view.next.arm, 'luna'); assert.equal(view.next.missionId, 'm1');
  assert.equal(view.runs[0].requests, 4); assert.equal(view.runs[0].artifact.requiresApproval, true);
  await writeFile(server.outputPath, JSON.stringify(fixture)); proc.emit('exit', 0, null);
  const done = await server.getState();
  assert.equal(done.status, 'complete'); assert.equal(done.completedWorkflows, 18); assert.equal(done.totalCalls, 36);
  assert.equal(done.runs.filter(run => run.cacheHit).length, 6);
  assert.ok(done.runs.filter(run => run.cacheHit).every(run => run.requests === 0 && run.cachedInputTokens === null));
  assert.equal(done.cost.accountedProviderUsd, fixture.accounting.accountedProviderUsd);
});

test('refuses existing evidence before spawn and never publishes arbitrary report fields or failures', async t => {
  const { createLiveDemoServer, buildLiveView } = await subject(), root = await temporary(t); let calls = 0;
  await mkdir(join(root, 'live-demo-existing')); await writeFile(join(root, 'live-demo-existing', 'report.json'), '{}');
  await assert.rejects(createLiveDemoServer({ runId: 'existing', envFile: 'unused', artifactRoot: root, port: 0,
    spawnImpl: () => { calls++; return child(); } }), /OUTPUT_EXISTS/);
  assert.equal(calls, 0);
  await assert.rejects(createLiveDemoServer({ runId: '../escape', envFile: 'unused', artifactRoot: root, port: 0 }), /INVALID_CONFIGURATION/);
  const view = buildLiveView({ status: 'running', apiKey: 'SECRET', accounting: { accountedProviderUsd: 'SECRET' },
    runs: [{ arm: 'astra', missionId: 'm1', phase: 'base', artifact: { injected: 'SECRET' },
      quality: { failures: ['SECRET'] }, synthesis: { reason: 'SECRET', usage: { cachedInputTokens: 'SECRET' } } }] },
  { runId: 'safe', status: 'running', startedAtMs: 1000, now: 2000 });
  assert.ok(!JSON.stringify(view).includes('SECRET')); assert.equal(view.cost.accountedProviderUsd, null);
  assert.equal(view.runs[0].artifact, null); assert.equal(view.elapsedMs, 1000);
});

test('child failures stay sanitized and closing terminates the child without a browser mutation endpoint', async t => {
  const { createLiveDemoServer } = await subject(), root = await temporary(t), proc = child();
  const server = await createLiveDemoServer({ runId: 'failure', envFile: 'unused', artifactRoot: root, port: 0, spawnImpl: () => proc });
  t.after(() => server.close()); await server.startRun(); proc.emit('error', new Error('SECRET credential in launch error'));
  const state = await server.getState(); assert.equal(state.status, 'failed'); assert.equal(state.reason, 'EVALUATOR_FAILED');
  assert.ok(!JSON.stringify(state).includes('SECRET'));
  await server.close();
});
