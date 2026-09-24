import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' }, timeout: 10000 });
}
test('doctor reports missing key without making a provider call', () => {
  const result = run(['doctor']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).keyConfigured, false);
  assert.equal(JSON.parse(result.stdout).liveJevChecked, false);
});
test('offline demonstration completes with explicit mock label', () => {
  const result = run(['demo']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.mode, 'offline-mock');
  assert.equal(data.liveJev, false);
  assert.equal(data.status, 'completed');
  assert.equal(data.completedSteps, 2);
});
test('invalid JSON is not echoed', () => {
  const result = run(['select'], 'a-private-screen-value');
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('a-private-screen-value'), false);
  assert.equal(JSON.parse(result.stdout).reason, 'CLI_INPUT_ERROR');
});
test('oversized stdin is rejected before inference', () => {
  const result = run(['select'], 'x'.repeat(33000));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).reason, 'INPUT_TOO_LARGE');
});

test('run requires a key before browser launch', () => {
  const plan = fileURLToPath(new URL('../examples/browser-plan.json', import.meta.url));
  const result = run(['run', '--plan', plan]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'MISSING_API_KEY');
});
