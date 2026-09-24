import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';

const input = { task: { id: 'task', revision: 1, request: 'private request' }, routes: [{ id: 'draft', description: 'Internal draft', kind: 'draft' }], baselineRouteId: 'draft' };
const noCall = () => assert.fail('No key or network access');
async function subject() { return import('../src/adaptive-router-cli.mjs'); }
test('CLI offline stdin preflight reads neither keys nor state and omits task text', async () => {
  const { runAdaptiveRouterCli } = await subject();
  const result = await runAdaptiveRouterCli(['--preflight'], { stdin: Readable.from([JSON.stringify(input)]), env: new Proxy({}, { get: noCall }) });
  assert.equal(result.exitCode, 0); assert.equal(result.result.status, 'preflight'); assert.ok(!JSON.stringify(result).includes('private request'));
});
test('CLI requires explicit live/state and rejects unknown duplicate incompatible flags', async () => {
  const { runAdaptiveRouterCli } = await subject();
  for (const argv of [[], ['--live'], ['--live', '--preflight'], ['--preflight', '--env-file', '.env'], ['--preflight', '--wat', 'x'],
    ['--preflight', '--preflight'], ['--live', '--state-dir'], ['--preflight', '--input', 'x', '--input', 'y']]) {
    assert.equal((await runAdaptiveRouterCli(argv, { env: new Proxy({}, { get: noCall }) })).exitCode, 2);
  }
});
test('CLI bounds stdin and sanitizes malformed JSON errors', async () => {
  const { runAdaptiveRouterCli } = await subject();
  for (const body of ['private malformed', ' '.repeat(1000001)]) {
    const result = await runAdaptiveRouterCli(['--preflight'], { stdin: Readable.from([body]) });
    assert.equal(result.exitCode, 2); assert.ok(!JSON.stringify(result).includes('private malformed'));
  }
});
test('CLI passes explicit env file and only TypeSafe/OpenRouter keys to advisory runner', async t => {
  const parent = resolve(tmpdir()), dir = await mkdtemp(join(parent, 'adaptive-cli-'));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(parent + sep) && basename(dir).startsWith('adaptive-cli-'));
    return rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const path = join(dir, 'input.json'); await writeFile(path, JSON.stringify(input));
  const { runAdaptiveRouterCli } = await subject();
  const env = new Proxy({ TYPESAFE_API_KEY: 'fake-type', OPENROUTER_API_KEY: 'fake-router' }, { get(target, key) {
    assert.notEqual(key, 'OPENAI_API_KEY'); return target[key];
  } });
  const result = await runAdaptiveRouterCli(['--live', '--input', path, '--state-dir', dir, '--env-file', 'explicit.env'], {
    env, runAdaptiveRoute: async (value, options) => {
      assert.deepEqual(value, input); assert.equal(options.envFile, 'explicit.env'); assert.equal(options.stateDir, dir);
      assert.deepEqual(options.apiKeys, { typesafe: 'fake-type', openrouter: 'fake-router' });
      return { status: 'selected', routeId: 'draft', requiresHostApproval: false, advisoryOnly: true };
    },
  });
  assert.equal(result.exitCode, 0); assert.equal(result.result.status, 'selected');
});

test('CLI live gate admits an unresolved offline selection for the state-aware runner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adaptive-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'config.json');
  const config = { estimates: { jev: { qualityEligible: false }, luna: { qualityEligible: true } } };
  await writeFile(configFile, JSON.stringify(config));
  const { runAdaptiveRouterCli } = await subject(); let runs = 0;
  const result = await runAdaptiveRouterCli(['--live', '--state-dir', dir, '--config', configFile], {
    stdin: Readable.from([JSON.stringify(input)]), env: {}, runAdaptiveRoute: async (_, options) => {
      runs++; assert.deepEqual(options.config, config); return { status: 'needs_host', reason: 'NO_ELIGIBLE_PROVIDER', requests: 0 };
    },
  });
  assert.equal(runs, 1); assert.equal(result.exitCode, 2); assert.equal(result.result.requests, 0);
});
