import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const runtimeUrl = pathToFileURL(join(packageDirectory, 'src', 'index.mjs')).href;
const skillDefinitions = {
  browser: { name: 'jev-computer-use', backupName: 'SKILL.md.before-claude-chrome-v1' },
  'task-router': { name: 'jev-task-router', backupName: 'SKILL.md.before-task-router-v1' },
  adaptive: { name: 'jev-adaptive-router', backupName: 'SKILL.md.before-adaptive-v1' },
  // Claude in Chrome tools exist only in Claude Code; Codex uses the CUA path in jev-computer-use.
  'claude-chrome': { name: 'jev-claude-chrome', backupName: 'SKILL.md.before-claude-chrome-v1', agents: ['claude'] },
};
const escapedRuntime = runtimeUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runtimeImport = new RegExp(`\\bimport\\s*\\(\\s*(["'])${escapedRuntime}\\1\\s*\\)`);

// Refuse links/junctions in the selected installation path. This also checks dangling links,
// unlike access(), so an install cannot accidentally write through an existing redirect.
async function checkDirectories(homeDirectory, destination) {
  const within = relative(homeDirectory, destination);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('SKILL_UNSAFE_PATH');
  const directories = [homeDirectory];
  for (const part of within.split(sep)) directories.push(join(directories.at(-1), part));
  for (const directory of directories) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SKILL_UNSAFE_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function renderSkill(content) {
  const replacements = {
    '__JEV_RUNTIME_URL__': runtimeUrl,
    '__JEV_PLAYWRIGHT_URL__': pathToFileURL(join(packageDirectory, 'src', 'playwright.mjs')).href,
    '__JEV_ENV_PATH_JSON__': JSON.stringify(join(packageDirectory, '.env')),
    '__JEV_CLI_PATH_JSON__': JSON.stringify(join(packageDirectory, 'src', 'cli.mjs')),
    '__JEV_CHROME_CLI_PATH_JSON__': JSON.stringify(join(packageDirectory, 'src', 'claude-chrome-cli.mjs')),
    '__JEV_ROUTER_CLI_PATH_JSON__': JSON.stringify(join(packageDirectory, 'src', 'router-cli.mjs')),
    '__JEV_ADAPTIVE_CLI_PATH_JSON__': JSON.stringify(join(packageDirectory, 'src', 'adaptive-router-cli.mjs')),
    '__JEV_PACKAGE_PATH_JSON__': JSON.stringify(packageDirectory),
  };
  for (const [marker, value] of Object.entries(replacements)) content = content.replaceAll(marker, value);
  if (/__JEV_[A-Z_]+__/.test(content)) throw new Error('UNRESOLVED_SKILL_TEMPLATE');
  return content;
}

export async function installSkills({ agent = 'both', skill = 'browser', homeDirectory = homedir(), update = false } = {}) {
  if (!['codex', 'claude', 'both'].includes(agent)) throw new Error('INVALID_AGENT');
  if (!['all', ...Object.keys(skillDefinitions)].includes(skill)) throw new Error('INVALID_SKILL');
  if (typeof update !== 'boolean') throw new Error('INVALID_UPDATE');
  if (typeof homeDirectory !== 'string' || !homeDirectory.trim()) throw new Error('INVALID_HOME');
  const home = resolve(homeDirectory);
  const agents = agent === 'both' ? ['codex', 'claude'] : [agent];
  const selected = skill === 'all' ? Object.values(skillDefinitions) : [skillDefinitions[skill]];
  const entries = [];
  // Validate all templates before touching either host. Only SKILL.md is copied; no runtime,
  // configuration, private state, credentials, or arbitrary files are included.
  for (const definition of selected) {
    const content = renderSkill(await readFile(new URL(`../skills/${definition.name}/SKILL.md`, import.meta.url), 'utf8'));
    for (const name of agents) if (!definition.agents || definition.agents.includes(name)) entries.push({ ...definition, content, destination: join(home, `.${name}`, 'skills', definition.name) });
  }
  if (!entries.length) throw new Error('SKILL_NOT_FOR_AGENT');
  const destinations = entries.map(entry => entry.destination);
  const originals = [];
  // Check every selected destination before creating backups or modifying either host.
  for (const { destination, backupName } of entries) {
    await checkDirectories(home, destination);
    if (!update) {
      try { await lstat(destination); throw new Error('SKILL_ALREADY_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    const skillFile = join(destination, 'SKILL.md');
    try {
      const directoryStat = await lstat(destination), skillStat = await lstat(skillFile);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error('SKILL_UNSAFE_PATH');
      const original = await readFile(skillFile, 'utf8');
      if (!runtimeImport.test(original)) throw new Error('SKILL_RUNTIME_MISMATCH');
      originals.push(original);
    } catch (error) { if (error.code === 'ENOENT') throw new Error('SKILL_NOT_FOUND'); throw error; }
    try { await lstat(join(destination, backupName)); throw new Error('SKILL_BACKUP_ALREADY_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (update) {
    // Recheck all originals, then create all exclusive backups before the first replacement.
    for (let index = 0; index < destinations.length; index++) {
      await checkDirectories(home, destinations[index]);
      const stat = await lstat(join(destinations[index], 'SKILL.md'));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL_UNSAFE_PATH');
      if (await readFile(join(destinations[index], 'SKILL.md'), 'utf8') !== originals[index]) throw new Error('SKILL_CHANGED_DURING_UPDATE');
    }
    const backups = entries.map(({ destination, backupName }) => join(destination, backupName));
    for (let index = 0; index < backups.length; index++) await writeFile(backups[index], originals[index], { flag: 'wx', encoding: 'utf8' });
    for (const { destination, content } of entries) await writeFile(join(destination, 'SKILL.md'), content, { encoding: 'utf8' });
    return { installed: [], updated: destinations, backups, runtime: packageDirectory, copiedSecrets: false };
  }
  const installed = [];
  for (const { destination, content } of entries) {
    await checkDirectories(home, destination);
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination); // Exclusive creation: ordinary installation never overwrites a skill.
    await writeFile(join(destination, 'SKILL.md'), content, { flag: 'wx', encoding: 'utf8' });
    installed.push(destination);
  }
  return { installed, runtime: packageDirectory, copiedSecrets: false };
}

export function parseInstallArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('INVALID_ARGUMENTS');
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = {}, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--update') { result.update = true; continue; }
    if (!['--agent', '--skill'].includes(flag)) throw new Error('INVALID_ARGUMENTS');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[flag.slice(2)] = value;
  }
  if (!result.agent) throw new Error('INVALID_ARGUMENTS');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const usage = 'Usage: node -- scripts/install-skill.mjs --agent codex|claude|both [--skill browser|task-router|adaptive|claude-chrome|all] [--update]\nDefault skill: browser. claude-chrome is installed for Claude only. Installs only SKILL.md; keeps the runtime and .env in this checkout. Existing destinations require --update from the same runtime and an unused release backup name.';
  try {
    const options = parseInstallArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(JSON.stringify(await installSkills(options)));
  } catch (error) {
      const allowed = ['INVALID_ARGUMENTS', 'INVALID_AGENT', 'INVALID_SKILL', 'SKILL_NOT_FOR_AGENT', 'INVALID_HOME', 'INVALID_UPDATE', 'SKILL_ALREADY_EXISTS', 'UNRESOLVED_SKILL_TEMPLATE', 'SKILL_NOT_FOUND', 'SKILL_UNSAFE_PATH', 'SKILL_RUNTIME_MISMATCH', 'SKILL_BACKUP_ALREADY_EXISTS', 'SKILL_CHANGED_DURING_UPDATE'];
      console.error(allowed.includes(error.message) ? error.message : 'SKILL_INSTALL_FAILED');
      if (error.message === 'INVALID_ARGUMENTS') console.error(usage);
      process.exitCode = 1;
  }
}
