#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 1000000;
const FLAGS = new Set(['--input', '--config', '--state-dir', '--env-file', '--mode']);
const MODES = new Set(['shadow', 'active', 'dry-run']);
const SUCCESS = new Set(['ready', 'shadow', 'dry_run', 'bypassed']);
const NEEDS_HOST = new Set(['needs_host', 'review_required']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stop = reason => ({ exitCode: 2, result: { status: 'needs_host', reason } });
const inputError = reason => { throw new Error(reason); };

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help'].includes(argv[0]))
      || (argv.length === 2 && ['route', 'handoff'].includes(argv[0]) && argv[1] === '--help')) return { help: true };
  if (!['route', 'handoff'].includes(argv[0])) return null;
  const flags = Object.create(null);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!FLAGS.has(flag) || Object.hasOwn(flags, flag) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    flags[flag] = value;
  }
  if (flags['--mode'] !== undefined && !MODES.has(flags['--mode'])) return null;
  if (argv[0] === 'handoff' && flags['--env-file'] !== undefined) return null;
  flags.command = argv[0];
  return flags;
}

function parseJson(bytes) {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

async function readJsonFile(path) {
  const handle = await open(resolve(path), 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) inputError('CLI_INPUT_ERROR');
    if (metadata.size > MAX_JSON_BYTES) inputError('INPUT_TOO_LARGE');
    // Read one extra byte and loop over short reads, bounding growth after stat.
    const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_JSON_BYTES) inputError('INPUT_TOO_LARGE');
    return parseJson(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}

async function readJsonStdin(stdin) {
  if (stdin?.isTTY) inputError('INPUT_REQUIRED');
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BYTES) inputError('INPUT_TOO_LARGE');
    chunks.push(buffer);
  }
  return parseJson(Buffer.concat(chunks, totalBytes));
}

/** Portable host entry point. The runner owns validation, credentials, state and billing. */
export async function runRouterCli(argv, {
  stdin = process.stdin, env = process.env, runRoutingTask, readReadyHandoff,
} = {}) {
  const flags = parseArguments(argv);
  if (!flags) return stop('INVALID_ARGUMENTS');
  if (flags.help) return { exitCode: 0, result: {
    status: 'help',
    invocation: 'node -- src/router-cli.mjs route [--input task.json] [--config router-config.json] [--mode shadow|active|dry-run] [--state-dir .jev-router] [--env-file .env]',
    handoffInvocation: 'node -- src/router-cli.mjs handoff [--input task.json] [--config router-config.json] --mode active --state-dir .jev-router',
    input: 'JSON from stdin when --input is absent or -. JSON files and stdin are limited to 1 MB each.',
    state: 'route requires an explicit private --state-dir except for dry-run or enabled:false; handoff always requires it. Keep the same directory to preserve replay and call limits.',
    modes: 'shadow calls Jev but keeps the baseline; active can prepare a local handoff; dry-run makes no API call. This command never executes a worker.',
    credentials: 'For route, use TYPESAFE_API_KEY in the environment or an explicitly selected --env-file. handoff uses neither. Never pass an API key as an argument.',
    handoff: 'Reads a committed handoff matching the current input and active configuration, with no API or key access. Does not repair files, create state, reserve calls, claim work, or execute a worker. --env-file is rejected. Only handoff_ready contains the task/evidence packet; keep stdout private and revalidate host permissions before execution.',
    exits: { '0': 'ready, shadow, dry_run, bypassed, handoff_ready or help', '2': 'needs_host or review_required' },
  } };

  let input, config;
  try {
    config = flags['--config'] === undefined ? {} : await readJsonFile(flags['--config']);
    if (!record(config)) inputError('CLI_INPUT_ERROR');
    if (flags['--mode'] !== undefined) config = { ...config, mode: flags['--mode'] };
    input = flags['--input'] === undefined || flags['--input'] === '-'
      ? await readJsonStdin(stdin) : await readJsonFile(flags['--input']);
  } catch (error) {
    return stop(['INPUT_REQUIRED', 'INPUT_TOO_LARGE'].includes(error?.message) ? error.message : 'CLI_INPUT_ERROR');
  }
  const handoff = flags.command === 'handoff';
  if (handoff && config.mode !== 'active') return stop('HANDOFF_REQUIRES_ACTIVE');
  if (!flags['--state-dir'] && (handoff || (config.enabled !== false && config.mode !== 'dry-run'))) return stop('STATE_DIR_REQUIRED');

  try {
    if (handoff) {
      const reader = readReadyHandoff ?? (await import('./router-task.mjs')).readReadyHandoff;
      const result = await reader(input, { config, stateDir: flags['--state-dir'] });
      if (!record(result) || !['handoff_ready', 'needs_host'].includes(result.status)) return stop('CLI_OUTPUT_ERROR');
      return { result, exitCode: result.status === 'handoff_ready' ? 0 : 2 };
    }
    const runner = runRoutingTask ?? (await import('./router-task.mjs')).runRoutingTask;
    const result = await runner(input, {
      config, stateDir: flags['--state-dir'], envFile: flags['--env-file'],
      apiKey: typeof env?.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY : '',
    });
    if (!record(result) || (!SUCCESS.has(result.status) && !NEEDS_HOST.has(result.status))) return stop('CLI_OUTPUT_ERROR');
    return { result, exitCode: SUCCESS.has(result.status) ? 0 : 2 };
  } catch {
    return stop('CLI_RUN_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRouterCli(process.argv.slice(2)).catch(() => stop('CLI_RUN_FAILED')).then(({ result, exitCode }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = exitCode;
  });
}
