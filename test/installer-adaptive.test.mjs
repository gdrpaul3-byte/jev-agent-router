import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir, access, mkdir, symlink } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installSkills, parseInstallArguments } from '../scripts/install-skill.mjs';

const exec = promisify(execFile);
const installer = fileURLToPath(new URL('../scripts/install-skill.mjs', import.meta.url));

async function withHome(fn) {
  const temporaryRoot = resolve(tmpdir());
  const home = await mkdtemp(join(temporaryRoot, 'jev-skill-release-'));
  try { await fn(home); }
  finally {
    const within = relative(temporaryRoot, resolve(home));
    assert.ok(within.startsWith('jev-skill-release-') && !within.includes(sep));
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('adaptive install has executable paths for both hosts and copies only instruction files', async () => {
  await withHome(async homeDirectory => {
    const result = await installSkills({ homeDirectory, skill: 'adaptive' });
    assert.equal(result.installed.length, 2);
    assert.equal(result.copiedSecrets, false);
    for (const directory of result.installed) {
      assert.ok(directory.endsWith('jev-adaptive-router'));
      assert.deepEqual(await readdir(directory), ['SKILL.md']);
      const content = await readFile(join(directory, 'SKILL.md'), 'utf8');
      assert.equal(content.includes('__JEV_'), false);
      const paths = JSON.parse(content.match(/```json\s*([\s\S]*?)```/)[1]);
      assert.equal(paths.envFile, join(paths.package, '.env'));
      await access(paths.cli);
      const { stdout } = await exec(process.execPath, ['--', paths.cli, '--preflight',
        '--input', join(paths.package, 'examples', 'adaptive-router-task.json'),
        '--config', join(paths.package, 'examples', 'adaptive-router-config.json')]);
      const preflight = JSON.parse(stdout);
      assert.equal(preflight.status, 'preflight');
    }
    await assert.rejects(access(join(homeDirectory, '.codex', 'skills', 'jev-computer-use')), /ENOENT/);
  });
});

test('all installs three portable skills per host plus the Claude-only Chrome skill', async () => {
  await withHome(async homeDirectory => {
    const result = await installSkills({ homeDirectory, skill: 'all' });
    assert.equal(result.installed.length, 7);
    for (const directory of result.installed) {
      assert.deepEqual(await readdir(directory), ['SKILL.md']);
      const content = await readFile(join(directory, 'SKILL.md'), 'utf8');
      assert.ok(!content.includes('__JEV_'));
    }
    assert.deepEqual((await readdir(join(homeDirectory, '.codex', 'skills'))).sort(), ['jev-adaptive-router', 'jev-computer-use', 'jev-task-router']);
    assert.deepEqual((await readdir(join(homeDirectory, '.claude', 'skills'))).sort(),
      ['jev-adaptive-router', 'jev-claude-chrome', 'jev-computer-use', 'jev-task-router']);
  });
});

test('Claude Chrome skill installs only for Claude with an executable helper path', async () => {
  await withHome(async homeDirectory => {
    await assert.rejects(installSkills({ homeDirectory, skill: 'claude-chrome', agent: 'codex' }), /SKILL_NOT_FOR_AGENT/);
    await assert.rejects(access(join(homeDirectory, '.codex')), /ENOENT/);
    const result = await installSkills({ homeDirectory, skill: 'claude-chrome' });
    assert.deepEqual(result.installed, [join(homeDirectory, '.claude', 'skills', 'jev-claude-chrome')]);
    const content = await readFile(join(result.installed[0], 'SKILL.md'), 'utf8');
    assert.ok(!content.includes('__JEV_'));
    const paths = JSON.parse(content.match(/```json\s*(\{ "cli"[\s\S]*?)```/)[1]);
    assert.equal(paths.envFile, join(paths.package, '.env'));
    const { stdout } = await exec(process.execPath, ['--', paths.cli, 'help']);
    assert.ok(JSON.parse(stdout).commands.some(command => command.startsWith('start --session')));
    const updated = await installSkills({ homeDirectory, skill: 'claude-chrome', agent: 'claude', update: true });
    assert.deepEqual(updated.backups, [join(result.installed[0], 'SKILL.md.before-playwright-ab-v1')]);
  });
});

test('adaptive updates preserve original content and never replace existing backup', async () => {
  await withHome(async homeDirectory => {
    const installed = (await installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex' })).installed[0];
    const original = `${await readFile(join(installed, 'SKILL.md'), 'utf8')}\nUser note.\n`;
    await writeFile(join(installed, 'SKILL.md'), original);
    const updated = await installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex', update: true });
    assert.equal(await readFile(updated.backups[0], 'utf8'), original);
    assert.ok(!(await readFile(join(installed, 'SKILL.md'), 'utf8')).includes('User note.'));
    await assert.rejects(installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex', update: true }), /SKILL_BACKUP_ALREADY_EXISTS/);
    assert.equal(await readFile(updated.backups[0], 'utf8'), original);
  });
});

test('all preflight refuses an existing later destination before creating earlier skills', async () => {
  await withHome(async homeDirectory => {
    await installSkills({ homeDirectory, skill: 'adaptive', agent: 'claude' });
    await assert.rejects(installSkills({ homeDirectory, skill: 'all' }), /SKILL_ALREADY_EXISTS/);
    await assert.rejects(access(join(homeDirectory, '.codex')), /ENOENT/);
    assert.deepEqual(await readdir(join(homeDirectory, '.claude', 'skills')), ['jev-adaptive-router']);
  });
});

test('ancestor symlink or junction is rejected without writing through it', async () => {
  await withHome(async homeDirectory => {
    const outside = join(homeDirectory, 'other-location');
    await mkdir(outside);
    await symlink(outside, join(homeDirectory, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex' }), /SKILL_UNSAFE_PATH/);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('different-runtime adaptive update does not overwrite existing skill', async () => {
  await withHome(async homeDirectory => {
    const installed = (await installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex' })).installed[0];
    const foreign = 'await import("file:///other-runtime/src/index.mjs");';
    await writeFile(join(installed, 'SKILL.md'), foreign);
    await assert.rejects(installSkills({ homeDirectory, skill: 'adaptive', agent: 'codex', update: true }), /SKILL_RUNTIME_MISMATCH/);
    assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), foreign);
    assert.deepEqual(await readdir(installed), ['SKILL.md']);
  });
});

test('legacy CLI arguments remain valid; skill selection is explicit and order independent', () => {
  assert.deepEqual(parseInstallArguments(['--agent', 'both']), { agent: 'both' });
  assert.deepEqual(parseInstallArguments(['--agent', 'codex', '--update']), { agent: 'codex', update: true });
  assert.deepEqual(parseInstallArguments(['--skill', 'adaptive', '--update', '--agent', 'claude']), { skill: 'adaptive', update: true, agent: 'claude' });
  for (const argv of [[], ['--skill', 'adaptive'], ['--agent'], ['--agent', 'codex', '--agent', 'claude'], ['--agent', 'codex', '--update', '--update'], ['--agent', 'codex', '--env-file', '.env']]) {
    assert.throws(() => parseInstallArguments(argv), /INVALID_ARGUMENTS/);
  }
});

test('help and invalid CLI invocations do not install any skills', async () => {
  const help = await exec(process.execPath, ['--', installer, '--help']);
  assert.match(help.stdout, /--skill browser\|task-router\|adaptive\|claude-chrome\|all/);
  await assert.rejects(exec(process.execPath, ['--', installer, '--agent', 'codex', '--skill', 'unknown']), error => error.code === 1 && error.stderr.trim() === 'INVALID_SKILL');
});
