import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills } from '../scripts/install-skill.mjs';

test('installs only two skill files with resolved runtime paths, never keys or config', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-install-'));
  try {
    const result = await installSkills({ homeDirectory });
    assert.equal(result.installed.length, 2);
    assert.equal(result.copiedSecrets, false);
    for (const directory of result.installed) {
      const skill = await readFile(join(directory, 'SKILL.md'), 'utf8');
      assert.equal(skill.includes('__JEV_'), false);
      assert.match(skill, /file:\/\/\/.*\/src\/index\.mjs/);
    }
    await writeFile(join(result.installed[0], 'SKILL.md'), 'existing-user-skill');
    await assert.rejects(installSkills({ homeDirectory }), /SKILL_ALREADY_EXISTS/);
    assert.equal(await readFile(join(result.installed[0], 'SKILL.md'), 'utf8'), 'existing-user-skill');
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('explicit update preserves both exact-runtime skills as exclusive backups', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-update-'));
  try {
    const first = await installSkills({ homeDirectory });
    const originals = [];
    for (const directory of first.installed) {
      const original = `${await readFile(join(directory, 'SKILL.md'), 'utf8')}\nLocal pre-upgrade note.\n`;
      await writeFile(join(directory, 'SKILL.md'), original); originals.push(original);
    }
    const result = await installSkills({ homeDirectory, update: true });
    assert.equal(result.updated.length, 2); assert.equal(result.backups.length, 2);
    assert.equal(result.copiedSecrets, false);
    for (let index = 0; index < result.updated.length; index++) {
      assert.equal(await readFile(result.backups[index], 'utf8'), originals[index]);
      const skill = await readFile(join(result.updated[index], 'SKILL.md'), 'utf8');
      assert.match(skill, /session\.goal|jevSession\.goal/);
      assert.match(skill, /createPlaywrightTarget/);
      assert.ok(!skill.includes('Local pre-upgrade note.'));
      assert.ok(!skill.includes('__JEV_'));
      assert.deepEqual((await readdir(result.updated[index])).sort(), ['SKILL.md', 'SKILL.md.before-claude-chrome-v1']);
    }
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('foreign second destination aborts both updates before any file or backup is written', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-foreign-'));
  try {
    const installed = (await installSkills({ homeDirectory })).installed;
    const original = await readFile(join(installed[0], 'SKILL.md'), 'utf8');
    await writeFile(join(installed[1], 'SKILL.md'), '---\nname: jev-computer-use\n---\nawait import("file:///C:/different-runtime/src/index.mjs");');
    await assert.rejects(installSkills({ homeDirectory, update: true }), /SKILL_RUNTIME_MISMATCH/);
    assert.equal(await readFile(join(installed[0], 'SKILL.md'), 'utf8'), original);
    for (const directory of installed) assert.deepEqual(await readdir(directory), ['SKILL.md']);
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('an existing backup is never overwritten and blocks both upgrades', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-backup-'));
  try {
    const installed = (await installSkills({ homeDirectory })).installed;
    const originals = await Promise.all(installed.map(directory => readFile(join(directory, 'SKILL.md'), 'utf8')));
    const backup = join(installed[1], 'SKILL.md.before-claude-chrome-v1'); await writeFile(backup, 'precious-backup');
    await assert.rejects(installSkills({ homeDirectory, update: true }), /SKILL_BACKUP_ALREADY_EXISTS/);
    assert.equal(await readFile(backup, 'utf8'), 'precious-backup');
    for (let index = 0; index < installed.length; index++) assert.equal(await readFile(join(installed[index], 'SKILL.md'), 'utf8'), originals[index]);
    await assert.rejects(access(join(installed[0], 'SKILL.md.before-claude-chrome-v1')), /ENOENT/);
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('browser update preserves the previous goal and browser release backups', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-prior-release-'));
  try {
    const installed = (await installSkills({ homeDirectory })).installed;
    for (const directory of installed) await writeFile(join(directory, 'SKILL.md.before-goal-v1'), 'original-goal-backup');
    for (const directory of installed) await writeFile(join(directory, 'SKILL.md.before-browser-v2'), 'browser-v2-backup');
    const result = await installSkills({ homeDirectory, update: true });
    assert.equal(result.updated.length, 2);
    for (const directory of installed) {
      assert.equal(await readFile(join(directory, 'SKILL.md.before-goal-v1'), 'utf8'), 'original-goal-backup');
      assert.equal(await readFile(join(directory, 'SKILL.md.before-browser-v2'), 'utf8'), 'browser-v2-backup');
      assert.ok((await readFile(join(directory, 'SKILL.md.before-claude-chrome-v1'), 'utf8')).includes('JEV'));
    }
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('update requires every destination to exist and does not silently install a missing host', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'jev-missing-'));
  try {
    const installed = (await installSkills({ homeDirectory, agent: 'codex' })).installed;
    const original = await readFile(join(installed[0], 'SKILL.md'), 'utf8');
    await assert.rejects(installSkills({ homeDirectory, update: true }), /SKILL_NOT_FOUND/);
    assert.equal(await readFile(join(installed[0], 'SKILL.md'), 'utf8'), original);
    assert.deepEqual(await readdir(installed[0]), ['SKILL.md']);
    await assert.rejects(access(join(homeDirectory, '.claude')), /ENOENT/);
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});
