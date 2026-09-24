#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareAdaptiveRoute, runAdaptiveRoute as defaultRun } from './adaptive-router.mjs';

const MAX_BYTES = 1000000;
const stop = reason => ({ exitCode: 2, result: { status: 'needs_host', reason } });
function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; if (Object.hasOwn(flags, flag)) return null;
    if (['--preflight', '--live'].includes(flag)) { flags[flag] = true; continue; }
    if (!['--input', '--config', '--state-dir', '--env-file'].includes(flag)) return null;
    const value = argv[++i]; if (!value?.trim() || value.startsWith('--')) return null; flags[flag] = value;
  }
  if (!!flags['--live'] === !!flags['--preflight'] || (flags['--live'] && !flags['--state-dir'])
      || (flags['--preflight'] && (flags['--env-file'] || flags['--state-dir']))) return null;
  return flags;
}
function parse(data) { return JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')); }
async function fileJson(path) {
  const handle = await open(resolve(path), 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new Error('CLI_INPUT_ERROR');
    if (stat.size > MAX_BYTES) throw new Error('INPUT_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) { const part = await handle.read(buffer, offset, buffer.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    if (offset > MAX_BYTES) throw new Error('INPUT_TOO_LARGE'); return parse(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}
async function stdinJson(stream) {
  if (!stream || stream.isTTY) throw new Error('INPUT_REQUIRED');
  const chunks = []; let size = 0;
  for await (const chunk of stream) { const value = Buffer.from(chunk); size += value.length; if (size > MAX_BYTES) throw new Error('INPUT_TOO_LARGE'); chunks.push(value); }
  return parse(Buffer.concat(chunks));
}

export async function runAdaptiveRouterCli(argv, { stdin = process.stdin, env = process.env, runAdaptiveRoute = defaultRun, fetchImpl } = {}) {
  const flags = argumentsFor(argv); if (!flags) return stop('INVALID_ARGUMENTS');
  if (flags.help) return { exitCode: 0, result: { status: 'help',
    invocation: 'node --use-system-ca src/adaptive-router-cli.mjs --live --input task.json --config adaptive-router-config.json --state-dir .adaptive-router [--env-file .env]',
    preflight: '--preflight [--input task.json] [--config config.json] validates offline, without keys, state or network. Omitted input or - reads stdin; JSON is limited to 1 MB.',
    scope: 'Advisory route choice only. The host supplies trusted difficulty/quality/cost observations and must revalidate permissions before execution. No worker is executed.',
    cache: 'Only exact normalized input, namespace/scope, policy and model/config matches replay; accepted cache TTL defaults to 300 seconds. A prompt-cache observation is not a promised provider cache hit.',
    limits: 'maxCalls is a hard POST cap. budgetUsd is an expected-cost planning threshold, not a prepaid provider spending cap. Unknown costs remain null. Uncertain attempts and stale locks require host review.',
    credentials: 'Only TYPESAFE_API_KEY and OPENROUTER_API_KEY from environment or the explicitly named env file. Never pass secrets as CLI flags.',
  } };
  let input, config;
  try { config = flags['--config'] ? await fileJson(flags['--config']) : {};
    input = flags['--input'] && flags['--input'] !== '-' ? await fileJson(flags['--input']) : await stdinJson(stdin);
  } catch (error) { return stop(['INPUT_TOO_LARGE', 'INPUT_REQUIRED'].includes(error?.message) ? error.message : 'CLI_INPUT_ERROR'); }
  const preflight = prepareAdaptiveRoute(input, { config });
  if (preflight.status !== 'preflight') return { exitCode: 2, result: preflight };
  if (flags['--preflight']) return { exitCode: 0, result: preflight };
  try {
    const result = await runAdaptiveRoute(input, { config, stateDir: flags['--state-dir'], envFile: flags['--env-file'],
      apiKeys: { typesafe: env?.TYPESAFE_API_KEY, openrouter: env?.OPENROUTER_API_KEY }, ...(fetchImpl ? { fetchImpl } : {}) });
    if (!result || !['selected', 'needs_host'].includes(result.status)) return stop('CLI_OUTPUT_ERROR');
    return { exitCode: result.status === 'selected' ? 0 : 2, result };
  } catch { return stop('CLI_OUTPUT_ERROR'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAdaptiveRouterCli(process.argv.slice(2)).catch(() => stop('CLI_OUTPUT_ERROR')).then(({ result, exitCode }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = exitCode;
  });
}
