import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

const cliPath = fileURLToPath(new URL('../src/router-cli.mjs', import.meta.url));
const sample = { task: { id: 'briefing', revision: 1, request: '자료를 조사해 주세요.' },
  routes: [{ id: 'research', description: 'Collect missing sources.', kind: 'read' }], baselineRouteId: 'research' };
const stream = value => Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]);
async function subject() {
  let module;
  try { module = await import('../src/router-cli.mjs'); }
  catch { assert.fail('The portable task router CLI must exist'); }
  assert.equal(typeof module.runRouterCli, 'function');
  return module.runRouterCli;
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-router-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const noDispatch = () => assert.fail('Invalid CLI input must not dispatch a paid decision');

test('JSON stdin dispatches exactly once with an explicit state directory and environment key', async () => {
  const run = await subject(); let calls = 0;
  const output = await run(['route', '--state-dir', '.private-state'], {
    stdin: stream(sample), env: { TYPESAFE_API_KEY: 'private-test-key' },
    runRoutingTask: async (input, options) => {
      calls++; assert.deepEqual(input, sample); assert.deepEqual(options.config, {});
      assert.equal(options.stateDir, '.private-state'); assert.equal(options.apiKey, 'private-test-key');
      return { status: 'shadow', recommendationId: 'research', effectiveRouteId: 'research' };
    },
  });
  assert.equal(calls, 1); assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'shadow');
  assert.ok(!JSON.stringify(output).includes('private-test-key'));
});

test('file input and config support Unicode paths, UTF-8 BOM and explicit mode override', async t => {
  const directory = await temporary(t);
  const inputPath = join(directory, '업무.json'), configPath = join(directory, '설정.json');
  await writeFile(inputPath, `\uFEFF${JSON.stringify(sample)}`);
  await writeFile(configPath, '\uFEFF{"mode":"shadow","maxCalls":5}');
  const output = await (await subject())(['route', '--input', inputPath, '--config', configPath,
    '--mode', 'active', '--state-dir', '.private-state', '--env-file', '.chosen-env'], {
    stdin: Readable.from((async function* () { assert.fail('File mode must not consume stdin'); })()), env: {},
    runRoutingTask: async (input, options) => {
      assert.deepEqual(input, sample); assert.deepEqual(options.config, { mode: 'active', maxCalls: 5 });
      assert.equal(options.envFile, '.chosen-env'); assert.equal(options.apiKey, '');
      return { status: 'ready' };
    },
  });
  assert.equal(output.exitCode, 0);
});

test('stdin dash and dry-run work without a persistent state directory', async () => {
  const output = await (await subject())(['route', '--input', '-', '--mode', 'dry-run'], {
    stdin: stream(sample), env: {}, runRoutingTask: async (_, options) => {
      assert.equal(options.stateDir, undefined); assert.equal(options.config.mode, 'dry-run');
      return { status: 'dry_run', requestBytes: 200 };
    },
  });
  assert.equal(output.exitCode, 0);
});

test('disabled config permits no state directory', async t => {
  const directory = await temporary(t), path = join(directory, 'disabled.json');
  await writeFile(path, '{"enabled":false}');
  const output = await (await subject())(['route', '--config', path], {
    stdin: stream(sample), env: {}, runRoutingTask: async (_, options) => {
      assert.equal(options.config.enabled, false); return { status: 'bypassed' };
    },
  });
  assert.equal(output.exitCode, 0);
});

test('paid modes require an explicit state directory before dispatch', async () => {
  const run = await subject();
  for (const args of [['route'], ['route', '--mode', 'active'], ['route', '--mode', 'shadow']]) {
    const output = await run(args, { stdin: stream(sample), runRoutingTask: noDispatch });
    assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'STATE_DIR_REQUIRED' } });
  }
});

test('unknown commands, unknown flags, duplicates, absent values and invalid modes are rejected', async () => {
  const run = await subject();
  for (const args of [
    ['execute'], ['help', '--input', 'file'], ['route', '--help', '--mode', 'active'],
    ['route', '--apikey', 'secret'], ['route', '--mode'], ['route', '--mode', '--input'],
    ['route', '--mode', 'dry-run', '--mode', 'active'], ['route', '--input', 'a', '--input', 'b'],
    ['route', '--mode', 'unrestricted'], ['route', '--state-dir', ''], ['route', 'unexpected'],
    ['route', '--mode=active'], ['route', '--', 'anything'],
  ]) {
    const output = await run(args, { stdin: stream(sample), runRoutingTask: noDispatch });
    assert.equal(output.exitCode, 2, JSON.stringify(args)); assert.equal(output.result.reason, 'INVALID_ARGUMENTS');
  }
});

test('help is JSON-ready and requires neither input nor runner loading', async () => {
  const run = await subject();
  for (const args of [[], ['help'], ['--help'], ['route', '--help']]) {
    const output = await run(args, { stdin: { isTTY: true }, runRoutingTask: noDispatch });
    assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'help');
    assert.match(output.result.invocation, /router-cli\.mjs/);
  }
});

test('malformed JSON and private exception messages never escape', async () => {
  const run = await subject();
  for (const input of ['private-task-secret', '{"token":"private-task-secret"', '']) {
    const output = await run(['route', '--mode', 'dry-run'], { stdin: stream(input), runRoutingTask: noDispatch });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, 'CLI_INPUT_ERROR');
    assert.ok(!JSON.stringify(output).includes('private-task-secret'));
  }
  const output = await run(['route', '--mode', 'dry-run'], {
    stdin: stream(sample), runRoutingTask: async () => { throw new Error('private-key private-task-secret'); },
  });
  assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'CLI_RUN_FAILED' } });
});

test('missing input in an interactive terminal returns a bounded error', async () => {
  const output = await (await subject())(['route', '--mode', 'dry-run'], { stdin: { isTTY: true }, runRoutingTask: noDispatch });
  assert.equal(output.result.reason, 'INPUT_REQUIRED'); assert.equal(output.exitCode, 2);
});

test('stdin byte cap is applied to UTF-8 bytes rather than JavaScript character count', async () => {
  const output = await (await subject())(['route', '--mode', 'dry-run'], {
    stdin: Readable.from(['"', '한'.repeat(333334), '"']), runRoutingTask: noDispatch,
  });
  assert.equal(output.result.reason, 'INPUT_TOO_LARGE'); assert.equal(output.exitCode, 2);
});

test('stdin consumes buffers split across UTF-8 boundaries correctly', async () => {
  const bytes = Buffer.from(JSON.stringify(sample));
  const output = await (await subject())(['route', '--mode', 'dry-run'], {
    stdin: Readable.from([...bytes].map(byte => Buffer.from([byte]))),
    runRoutingTask: async input => { assert.deepEqual(input, sample); return { status: 'dry_run' }; },
  });
  assert.equal(output.exitCode, 0);
});

test('input files above 1 MB and non-file paths are rejected without dispatch', async t => {
  const directory = await temporary(t), path = join(directory, 'oversized.json');
  await writeFile(path, ' '.repeat(1000001));
  const run = await subject();
  const large = await run(['route', '--mode', 'dry-run', '--input', path], { runRoutingTask: noDispatch });
  assert.equal(large.result.reason, 'INPUT_TOO_LARGE');
  const folder = await run(['route', '--mode', 'dry-run', '--input', directory], { runRoutingTask: noDispatch });
  assert.equal(folder.exitCode, 2); assert.equal(folder.result.reason, 'CLI_INPUT_ERROR');
});

test('the exact 1 MB file boundary is accepted before semantic validation', async t => {
  const directory = await temporary(t), path = join(directory, 'boundary.json');
  await writeFile(path, '{}'.padEnd(1000000, ' '));
  const output = await (await subject())(['route', '--mode', 'dry-run', '--input', path], {
    runRoutingTask: async input => { assert.deepEqual(input, {}); return { status: 'needs_host', reason: 'INVALID_INPUT' }; },
  });
  assert.equal(output.result.reason, 'INVALID_INPUT');
});

test('config reads have the same byte cap and reject non-object values before merging a mode', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json'), run = await subject();
  for (const body of [' '.repeat(1000001), 'null', '[]', '"private-config-secret"', '{broken']) {
    await writeFile(path, body);
    const output = await run(['route', '--mode', 'dry-run', '--config', path], { stdin: stream(sample), runRoutingTask: noDispatch });
    assert.equal(output.exitCode, 2);
    assert.equal(output.result.reason, body.length > 1000000 ? 'INPUT_TOO_LARGE' : 'CLI_INPUT_ERROR');
    assert.ok(!JSON.stringify(output).includes('private-config-secret'));
  }
});

test('missing file errors do not print the requested path', async () => {
  const output = await (await subject())(['route', '--mode', 'dry-run', '--input', 'private-secret-path/absent.json'], { runRoutingTask: noDispatch });
  assert.equal(output.result.reason, 'CLI_INPUT_ERROR'); assert.ok(!JSON.stringify(output).includes('private-secret-path'));
});

test('ready/shadow/dry_run/bypassed exit zero; host review or failure exits two', async () => {
  const run = await subject();
  for (const status of ['ready', 'shadow', 'dry_run', 'bypassed', 'needs_host', 'review_required']) {
    const output = await run(['route', '--mode', 'dry-run'], { stdin: stream(sample), runRoutingTask: async () => ({ status }) });
    assert.equal(output.exitCode, ['needs_host', 'review_required'].includes(status) ? 2 : 0);
  }
});

test('unexpected runner output fails closed instead of reporting successful execution', async () => {
  const run = await subject();
  for (const value of [undefined, null, 'private-output-secret', { status: 'executed', secret: 'private-output-secret' }]) {
    const output = await run(['route', '--mode', 'dry-run'], { stdin: stream(sample), runRoutingTask: async () => value });
    assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'CLI_OUTPUT_ERROR' } });
  }
});

test('portable process invocation emits exactly one JSON stdout line and the documented exit code', async () => {
  await subject();
  const help = spawnSync(process.execPath, ['--', cliPath, '--help'], { cwd: dirname(cliPath), encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stderr, ''); assert.equal(JSON.parse(help.stdout).status, 'help');
  assert.equal(help.stdout.trim().split('\n').length, 1);
  const invalid = spawnSync(process.execPath, ['--', cliPath, 'route', '--mode', 'dry-run'], {
    input: 'private-stdin-secret', encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: 'private-api-secret' },
  });
  assert.equal(invalid.status, 2); assert.equal(invalid.stderr, '');
  assert.equal(JSON.parse(invalid.stdout).reason, 'CLI_INPUT_ERROR');
  assert.ok(!invalid.stdout.includes('private-'));
});

test('handoff reads verified packets locally without accessing credentials or the paid runner', async () => {
  let calls = 0;
  const secretEnv = new Proxy({}, { get() { assert.fail('handoff must not read any environment key'); } });
  const packet = { task: sample.task, routeId: 'research', executionStatus: 'not_started' };
  const output = await (await subject())(['handoff', '--mode', 'active', '--state-dir', '.private-state'], {
    stdin: stream(sample), env: secretEnv, runRoutingTask: noDispatch,
    readReadyHandoff: async (input, options) => {
      calls++; assert.deepEqual(input, sample);
      assert.deepEqual(options, { config: { mode: 'active' }, stateDir: '.private-state' });
      return { status: 'handoff_ready', packet, cost: { estimatedJevUsd: 0 }, requests: [],
        replayed: true, requiresFreshHostValidation: true, executionClaimed: false };
    },
  });
  assert.equal(calls, 1); assert.equal(output.exitCode, 0); assert.equal(output.result.status, 'handoff_ready');
  assert.deepEqual(output.result.packet, packet); assert.equal(output.result.executionClaimed, false);
});

test('handoff accepts active config, mode override and input files with the same validated reader', async t => {
  const directory = await temporary(t), taskPath = join(directory, 'task.json'), configPath = join(directory, 'config.json');
  await writeFile(taskPath, JSON.stringify(sample)); await writeFile(configPath, '{"mode":"active","enabled":true}');
  const output = await (await subject())(['handoff', '--input', taskPath, '--config', configPath, '--state-dir', '.private-state'], {
    runRoutingTask: noDispatch, readReadyHandoff: async (input, options) => {
      assert.deepEqual(input, sample); assert.deepEqual(options.config, { mode: 'active', enabled: true });
      return { status: 'handoff_ready' };
    },
  });
  assert.equal(output.exitCode, 0);
  await writeFile(configPath, '{"mode":"shadow"}');
  const overridden = await (await subject())(['handoff', '--input', taskPath, '--config', configPath,
    '--mode', 'active', '--state-dir', '.private-state'], {
    readReadyHandoff: async (_, options) => { assert.equal(options.config.mode, 'active'); return { status: 'handoff_ready' }; },
  });
  assert.equal(overridden.exitCode, 0);
});

test('handoff always requires an active mode and explicit persistent directory', async () => {
  const run = await subject();
  for (const args of [['handoff', '--state-dir', '.state'], ['handoff', '--mode', 'shadow', '--state-dir', '.state'],
    ['handoff', '--mode', 'dry-run', '--state-dir', '.state']]) {
    const output = await run(args, { stdin: stream(sample), runRoutingTask: noDispatch, readReadyHandoff: noDispatch });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, 'HANDOFF_REQUIRES_ACTIVE');
  }
  const output = await run(['handoff', '--mode', 'active'], {
    stdin: stream(sample), runRoutingTask: noDispatch, readReadyHandoff: noDispatch,
  });
  assert.equal(output.exitCode, 2); assert.equal(output.result.reason, 'STATE_DIR_REQUIRED');
});

test('handoff rejects env-file, duplicate and unknown flags before reading input', async () => {
  const run = await subject();
  for (const args of [
    ['handoff', '--mode', 'active', '--env-file', '.private-secret'],
    ['handoff', '--mode', 'active', '--mode', 'active'],
    ['handoff', '--repair', 'true'], ['handoff', '--help', '--mode', 'active'],
  ]) {
    const output = await run(args, { stdin: { isTTY: true }, runRoutingTask: noDispatch, readReadyHandoff: noDispatch });
    assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'INVALID_ARGUMENTS' } });
  }
});

test('handoff malformed or oversized input does not access the ledger reader', async () => {
  const run = await subject();
  for (const [input, reason] of [['private-input-secret', 'CLI_INPUT_ERROR'], [' '.repeat(1000001), 'INPUT_TOO_LARGE']]) {
    const output = await run(['handoff', '--mode', 'active', '--state-dir', '.state'], {
      stdin: stream(input), runRoutingTask: noDispatch, readReadyHandoff: noDispatch,
    });
    assert.equal(output.exitCode, 2); assert.equal(output.result.reason, reason);
    assert.ok(!JSON.stringify(output).includes('private-input-secret'));
  }
});

test('handoff preserves a missing-file host result instead of repairing or rerouting', async () => {
  const output = await (await subject())(['handoff', '--mode', 'active', '--state-dir', '.state'], {
    stdin: stream(sample), runRoutingTask: noDispatch,
    readReadyHandoff: async () => ({ status: 'needs_host', reason: 'HANDOFF_MISSING' }),
  });
  assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'HANDOFF_MISSING' } });
});

test('handoff rejects unrelated success statuses and sanitizes reader exceptions', async () => {
  const run = await subject();
  for (const status of ['ready', 'shadow', 'bypassed', 'dry_run']) {
    const output = await run(['handoff', '--mode', 'active', '--state-dir', '.state'], {
      stdin: stream(sample), readReadyHandoff: async () => ({ status, packet: 'private-task-secret' }),
    });
    assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'CLI_OUTPUT_ERROR' } });
  }
  const output = await run(['handoff', '--mode', 'active', '--state-dir', '.state'], {
    stdin: stream(sample), readReadyHandoff: async () => { throw new Error('private-ledger-secret'); },
  });
  assert.deepEqual(output, { exitCode: 2, result: { status: 'needs_host', reason: 'CLI_RUN_FAILED' } });
});

test('route refuses handoff_ready output and handoff help describes local-only behavior', async () => {
  const run = await subject();
  const output = await run(['route', '--mode', 'dry-run'], {
    stdin: stream(sample), runRoutingTask: async () => ({ status: 'handoff_ready' }),
  });
  assert.equal(output.result.reason, 'CLI_OUTPUT_ERROR');
  const help = await run(['handoff', '--help'], { stdin: { isTTY: true }, runRoutingTask: noDispatch, readReadyHandoff: noDispatch });
  assert.equal(help.exitCode, 0); assert.equal(help.result.status, 'help');
  assert.match(help.result.handoff, /no API/i); assert.match(help.result.handoff, /does not repair/i);
});
