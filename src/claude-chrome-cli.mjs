#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClaudeChromeCommand } from './claude-chrome-command.mjs';
import { normalizeClaudeObservation } from './claude-observation.mjs';
import { startClaudeChromeSession, runClaudeChromeSession, unlockClaudeChromeSession } from './claude-chrome-session.mjs';

export { runClaudeChromeCommand };
const MAX_INPUT_BYTES = 1000000;
const stop = reason => ({ status: 'needs_host', reason });
const COMMANDS = ['observe', 'start', 'status', 'decide', 'authorize', 'verify', 'unlock'];

async function readInput(file) {
  if (file) {
    const handle = await open(resolve(file), 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, ''));
    } finally { await handle.close(); }
  }
  if (process.stdin.isTTY) throw new Error('INPUT_REQUIRED');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
}

async function readText(file) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    return { text: (await handle.readFile('utf8')).replace(/^﻿/, ''), writtenAtEpochMs: Math.floor(metadata.mtimeMs) };
  } finally { await handle.close(); }
}

// One file per official tool result, copied verbatim. Separate files keep page-controlled text
// (page text, previous field values) from forging another tool's section. The files are written after
// the tools return, so the oldest write time bounds the capture time and a reused directory is not fresh.
async function readRawDirectory(directory, tabId, command) {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(tabId ?? '')) throw new Error('INVALID_ARGUMENTS');
  const read = name => readText(join(resolve(directory), name));
  const optional = async name => { try { return await read(name); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
  const parts = [await read('tabs-context.txt'), await read('read-page.txt'), await read('page-text.txt')];
  const refCheck = command === 'decide' ? undefined : await optional('ref-check.txt');
  // A ref check left over from an older read would bind a forged line, so it bounds the capture time too.
  const raw = { tabId: Number(tabId), tabsContext: parts[0].text, readPage: parts[1].text, pageText: parts[2].text,
    ...(refCheck ? { refCheck: refCheck.text } : {}), observedAtEpochMs: Math.min(...[...parts, ...(refCheck ? [refCheck] : [])].map(part => part.writtenAtEpochMs)) };
  if (command !== 'verify') return { raw };
  const report = await optional('tool-result.txt');
  return report ? { raw, toolResult: report.text.replace(/\r?\n$/, ''), toolResultAtEpochMs: report.writtenAtEpochMs } : { raw };
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help'].includes(command)) return {
    commands: ['observe (--raw DIR --tab-id N | --input PATH)', 'start --session DIR [--input PATH]', 'status --session DIR',
      'decide|authorize|verify --session DIR (--raw DIR --tab-id N | --input PATH) [--env-file PATH for decide]',
      'unlock --session DIR --pid N (only when the recorded lock owner process has exited; --pid 0 for an ownerless lock older than 10 minutes)',
      'decide [--input PATH] [--env-file PATH]', 'authorize [--input PATH]', 'verify [--input PATH]'],
    rawDirectory: ['tabs-context.txt', 'read-page.txt (filter "interactive")', 'page-text.txt',
      'ref-check.txt (authorize, and verify after form_input: read_page with ref_id of the target)', 'tool-result.txt (verify after form_input)'],
    invocation: 'node -- <claude-chrome-cli.mjs> <command> [options]',
    note: 'Host-assisted decisions only. Claude reads the page, authorizes a fresh reference, invokes its own browser tool once, and verifies afterward. See docs/claude-chrome.md.',
  };
  if (!COMMANDS.includes(command)) return stop('INVALID_ARGUMENTS');
  const options = {};
  const flags = command === 'unlock' ? ['--session', '--pid'] : ['--input', '--env-file', '--session', '--raw', '--tab-id'];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flags.includes(flag) || options[flag] !== undefined || !value || value.startsWith('--')
        || (command !== 'decide' && flag === '--env-file') || (command === 'observe' && flag === '--session')) return stop('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  if (command === 'unlock') {
    if (!options['--session'] || !/^(?:0|[1-9]\d{0,9})$/.test(options['--pid'] ?? '')) return stop('INVALID_ARGUMENTS');
    return unlockClaudeChromeSession({ sessionDir: options['--session'], pid: Number(options['--pid']) });
  }
  const session = options['--session'], rawDirectory = options['--raw'];
  if ((['start', 'status'].includes(command) && !session) || (rawDirectory !== undefined) !== (options['--tab-id'] !== undefined)
      || (rawDirectory && (options['--input'] || ['start', 'status'].includes(command) || (!session && command !== 'observe')))) return stop('INVALID_ARGUMENTS');
  if (command === 'status') return options['--input'] ? stop('INVALID_ARGUMENTS') : runClaudeChromeSession('status', {}, { sessionDir: session });
  const input = rawDirectory ? await readRawDirectory(rawDirectory, options['--tab-id'], command) : await readInput(options['--input']);
  if (command === 'observe') return normalizeClaudeObservation(rawDirectory ? input.raw : input);
  if (command === 'start') return startClaudeChromeSession(input, { sessionDir: session });
  const secrets = { envFile: options['--env-file'], apiKey: process.env.TYPESAFE_API_KEY ?? '' };
  return session ? runClaudeChromeSession(command, input, { sessionDir: session, ...secrets }) : runClaudeChromeCommand(command, input, secrets);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => stop(['INPUT_TOO_LARGE', 'INPUT_REQUIRED', 'INVALID_ARGUMENTS'].includes(error?.message) ? error.message : 'CLI_INPUT_ERROR')).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'needs_host') process.exitCode = 2;
  });
}
