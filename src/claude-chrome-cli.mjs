#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecider } from './decider.mjs';
import { loadApiKey } from './config.mjs';
import { createMeteredFetch, summarizeBilling } from './meter.mjs';
import { proposeClaudeChrome, authorizeClaudeChrome, verifyClaudeChromeAction } from './claude-chrome.mjs';

const MAX_INPUT_BYTES = 1000000;
const stop = reason => ({ status: 'needs_host', reason });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Callable wrapper and CLI share exactly the same validation/cost path. */
export async function runClaudeChromeCommand(command, input, { envFile, apiKey = '', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (command === 'authorize') return authorizeClaudeChrome(input, { now });
  if (command === 'verify') return verifyClaudeChromeAction(input, { now });
  if (command !== 'decide') return stop('INVALID_ARGUMENTS');
  const api = input?.api ?? {};
  const bounds = { timeoutMs: [1, 60000], maxInputBytes: [1, MAX_INPUT_BYTES], minConfidence: [0.75, 1], minMargin: [0.1, 1] };
  if (!record(api) || Object.entries(api).some(([key, value]) => !bounds[key] || !Number.isFinite(value)
      || value < bounds[key][0] || value > bounds[key][1]
      || (key === 'maxInputBytes' && !Number.isSafeInteger(value)))) return stop('INVALID_API_OPTIONS');
  const meter = createMeteredFetch({ fetchImpl });
  // Key loading is delayed until the envelope/plan/history have passed validation.
  const decider = { decide: async payload => {
    try {
      const key = await loadApiKey({ apiKey, envFile });
      return await createDecider({ apiKey: key, fetchImpl: meter.fetchImpl, maxCalls: 1, timeoutMs: 5000, maxInputBytes: 100000, ...api }).decide(payload);
    } catch (error) {
      return stop(['JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID'].includes(error?.message) ? error.message : 'DECISION_FAILED');
    }
  } };
  const result = await proposeClaudeChrome(input, { decider, now });
  const usage = await meter.flush({ timeoutMs: 2000 });
  return { ...result, usage, cost: summarizeBilling(usage), requests: meter.records() };
}

async function readInput(file) {
  if (file) {
    const handle = await open(resolve(file), 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
    } finally { await handle.close(); }
  }
  if (process.stdin.isTTY) throw new Error('INPUT_REQUIRED');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help'].includes(command)) return {
    commands: ['decide [--input PATH] [--env-file PATH]', 'authorize [--input PATH]', 'verify [--input PATH]'],
    invocation: 'node -- <claude-chrome-cli.mjs> <command> [options]',
    note: 'Host-assisted decisions only. Claude reads the page, authorizes a fresh reference, invokes its own browser tool once, and verifies afterward. See docs/claude-chrome.md.',
  };
  if (!['decide', 'authorize', 'verify'].includes(command)) return stop('INVALID_ARGUMENTS');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--input', '--env-file'].includes(flag) || options[flag] !== undefined || !value || value.startsWith('--')
        || (command !== 'decide' && flag === '--env-file')) return stop('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  return runClaudeChromeCommand(command, await readInput(options['--input']), { envFile: options['--env-file'], apiKey: process.env.TYPESAFE_API_KEY ?? '' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => stop(['INPUT_TOO_LARGE', 'INPUT_REQUIRED'].includes(error?.message) ? error.message : 'CLI_INPUT_ERROR')).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'needs_host') process.exitCode = 2;
  });
}
