#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSelector } from './selector.mjs';
import { loadApiKey } from './config.mjs';
import { runOfflineDemo } from '../examples/offline.mjs';

const MAX_INPUT_BYTES = 32000;
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function parseArgs(args) {
  const [command = 'help', ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (Object.hasOwn(options, flag)) throw new Error('INVALID_ARGUMENTS');
    if (flag === '--headless') { options[flag] = true; continue; }
    if (!['--env-file', '--input', '--plan', '--channel'].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')) {
      throw new Error('INVALID_ARGUMENTS');
    }
    options[flag] = rest[++i];
  }
  return { command, options };
}

async function readInput(file) {
  if (file) {
    const path = resolve(file);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    const buffer = await readFile(path);
    if (buffer.length > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  }
  if (process.stdin.isTTY) throw new Error('INPUT_REQUIRED');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help') {
    output({ commands: ['doctor [--env-file PATH]', 'demo', 'select [--input PATH] [--env-file PATH]', 'run --plan PATH [--env-file PATH] [--channel chrome|msedge|chromium] [--headless]', 'goal --plan PATH [--env-file PATH] [--channel chrome|msedge|chromium] [--headless]'],
      invocation: 'node -- <cli-path> <command> [options] (the -- prevents Node from consuming the application --env-file option).',
      note: 'select sends the supplied observation to TypeSafe and returns a target only; it performs no UI actions.' });
    return;
  }
  if (command === 'demo') {
    const result = await runOfflineDemo();
    output(result);
    if (result.status !== 'completed') process.exitCode = 1;
    return;
  }
  if (!['doctor', 'select', 'run', 'goal'].includes(command)) throw new Error('INVALID_ARGUMENTS');
  if (command === 'goal') {
    if (!options['--plan']) throw new Error('INVALID_ARGUMENTS');
    const { runBrowserGoal } = await import('./browser-goal.mjs');
    const result = await runBrowserGoal({ plan: await readInput(options['--plan']), apiKey: process.env.TYPESAFE_API_KEY,
      envFile: options['--env-file'], channel: options['--channel'] ?? 'chrome', headless: options['--headless'] === true });
    output(result);
    if (result.status !== 'completed') process.exitCode = 2;
    return;
  }
  const apiKey = await loadApiKey({ apiKey: process.env.TYPESAFE_API_KEY, envFile: options['--env-file'] });
  if (command === 'run') {
    if (!options['--plan']) throw new Error('INVALID_ARGUMENTS');
    const { runBrowserPlan } = await import('./browser-run.mjs');
    const result = await runBrowserPlan({ plan: await readInput(options['--plan']), apiKey,
      channel: options['--channel'] ?? 'chrome', headless: options['--headless'] === true });
    output(result);
    if (result.status !== 'completed') process.exitCode = 2;
    return;
  }
  if (command === 'doctor') {
    let playwrightInstalled = false;
    try { await import('playwright-core'); playwrightInstalled = true; } catch {}
    output({ node: process.versions.node, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24,
      keyConfigured: Boolean(apiKey), liveJevChecked: false, coreDependencies: 'none', browserDependency: 'playwright-core (optional)',
      continuousMode: 'Import src/index.mjs in the persistent REPL holding the CUA target; session.workflow() runs fixed steps and session.goal() runs a bounded goal loop.',
      playwrightInstalled,
      claudeMode: 'run --plan PATH and goal --plan PATH start isolated browser contexts, without personal profiles; select only returns a target.' });
    return;
  }
  const result = await createSelector({ apiKey, maxCalls: 1 }).select(await readInput(options['--input']));
  output(result);
  if (result.status !== 'selected') process.exitCode = 2;
}

main().catch(error => {
  const allowed = ['INVALID_ARGUMENTS', 'INPUT_TOO_LARGE', 'INPUT_REQUIRED', 'JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID'];
  output({ status: 'needs_host', reason: allowed.includes(error?.message) ? error.message : 'CLI_INPUT_ERROR' });
  process.exitCode = 1;
});

