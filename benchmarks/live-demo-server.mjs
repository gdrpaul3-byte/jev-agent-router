#!/usr/bin/env node
// Local recording surface. Only terminal/host code can start paid work; HTTP is read-only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { scoreMission } from './complex-mission-cases.mjs';

const ROOT = fileURLToPath(new URL('./results/', import.meta.url));
const EVALUATOR = fileURLToPath(new URL('./complex-mission-eval.mjs', import.meta.url));
const ARMS = ['astra', 'luna', 'adaptive'], PHASES = ['base', 'changed', 'exact_repeat'];
const SCHEDULE = ['m1', 'm2'].flatMap(missionId => PHASES.flatMap((phase, i) =>
  [...ARMS.slice(i), ...ARMS.slice(0, i)].map(arm => ({ missionId, phase, arm }))));
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : 0;
const boolean = x => x === true;
const allowed = (x, values) => values.includes(x) ? x : null;
const fail = code => { throw new Error(code); };
const failureName = name => typeof name === 'string' && /^(?:structure|selection|deadline|approval|budget\.(?:eligibleCostWon|grantWon|ownContributionWon|remainingBudgetWon)|candidate\.c[123]\.(?:decision|reasons|evidence)|action\.[1234]\.(?:code|targets|prerequisites|approval|evidence))$/.test(name);

/** Public projection: no prompts, environment paths, arbitrary error strings or original raw responses. */
export function buildLiveView(report, meta) {
  const runs = (Array.isArray(report?.runs) ? report.runs : []).slice(0, 18).filter(row => row && ARMS.includes(row.arm)
    && ['m1', 'm2'].includes(row.missionId) && PHASES.includes(row.phase)).map(row => ({
    index: count(row.index), arm: row.arm, missionId: row.missionId, phase: row.phase,
    status: allowed(row.status, ['produced', 'routing_failed', 'synthesis_failed']), requests: count(row.requests),
    cacheHit: boolean(row.cacheHit), latencyMs: finite(row.latencyMs),
    costUsd: finite(row.cost?.accountedProviderUsd), costComplete: boolean(row.cost?.complete),
    corePassed: boolean(row.quality?.corePassed), strictPassed: boolean(row.quality?.passed),
    checksPassed: count(row.quality?.checksPassed), checksTotal: count(row.quality?.checksTotal),
    failures: (Array.isArray(row.quality?.failures) ? row.quality.failures : []).filter(failureName),
    // Replay rows retain original usage in the source report; never display it as new consumption.
    cachedInputTokens: row.cacheHit ? null : finite(row.synthesis?.usage?.cachedInputTokens),
    cacheWriteTokens: row.cacheHit ? null : finite(row.synthesis?.usage?.cacheWriteTokens),
    artifact: scoreMission(row.artifact, { output: row.artifact }).passed ? row.artifact : null,
  }));
  const status = meta.status === 'running' && ['complete', 'stopped'].includes(report?.status) ? report.status : meta.status;
  const accounting = report?.accounting;
  const cost = { accountedProviderUsd: finite(accounting?.accountedProviderUsd),
    reportedProviderUsd: finite(accounting?.reportedProviderUsd), estimatedProviderUsd: finite(accounting?.estimatedProviderUsd),
    complete: boolean(accounting?.complete) };
  if (!report) Object.assign(cost, { accountedProviderUsd: 0, reportedProviderUsd: 0, estimatedProviderUsd: 0, complete: true });
  return { schemaVersion: 1, runId: meta.runId, status, reason: status === 'failed' ? 'EVALUATOR_FAILED' : null,
    serverNow: meta.now, startedAtMs: meta.startedAtMs, finishedAtMs: meta.finishedAtMs ?? null,
    elapsedMs: meta.startedAtMs === null ? 0 : Math.max(0, (meta.finishedAtMs ?? meta.now) - meta.startedAtMs),
    plannedWorkflows: 18, completedWorkflows: runs.length, totalCalls: count(accounting?.requests), cost,
    next: status === 'running' ? SCHEDULE[runs.length] ?? null : null,
    limits: { budgetUsd: 5, maxRequests: 80, hardPrepaidCap: false },
    arms: ARMS.map(arm => {
      const rows = runs.filter(row => row.arm === arm), fresh = rows.filter(row => !row.cacheHit);
      return { arm, completed: rows.length, fresh: fresh.length, corePassed: fresh.filter(row => row.corePassed).length,
        strictPassed: fresh.filter(row => row.strictPassed).length, exactReplays: rows.filter(row => row.cacheHit).length,
        requests: rows.reduce((n, row) => n + row.requests, 0),
        costUsd: rows.some(row => row.costUsd === null) ? null : rows.reduce((n, row) => n + row.costUsd, 0),
        meanFreshMs: fresh.length ? fresh.reduce((n, row) => n + (row.latencyMs ?? 0), 0) / fresh.length : null };
    }), runs };
}

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function noSymlink(path) { try { if ((await lstat(path)).isSymbolicLink()) fail('INVALID_CONFIGURATION'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function checkpoint(path) {
  try {
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000) return null;
    const handle = await open(path, 'r');
    try {
      const data = Buffer.alloc(4000001); const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > 4000000) return null;
      return JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  } catch { return null; }
}

export async function createLiveDemoServer({ runId, envFile, port = 8786, artifactRoot = ROOT, spawnImpl = spawn } = {}) {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(runId) || typeof envFile !== 'string' || !envFile.trim()
      || !Number.isSafeInteger(port) || port < 0 || port > 65535 || typeof spawnImpl !== 'function') fail('INVALID_CONFIGURATION');
  const root = resolve(artifactRoot), directory = resolve(root, `live-demo-${runId}`), outputPath = join(directory, 'report.json');
  if (!directory.startsWith(root + sep)) fail('INVALID_CONFIGURATION');
  await noSymlink(root); await noSymlink(directory);
  if (await exists(outputPath) || await exists(`${outputPath}.manifest.json`)) fail('OUTPUT_EXISTS');
  const html = await readFile(new URL('./live-demo.html', import.meta.url), 'utf8');
  let status = 'idle', startedAtMs = null, finishedAtMs = null, proc = null, latest = null, closing = false;
  const getState = async () => {
    if (status !== 'idle') latest = await checkpoint(outputPath) ?? latest;
    return buildLiveView(latest, { runId, status, startedAtMs, finishedAtMs, now: Date.now() });
  };
  const startRun = async () => {
    if (status !== 'idle' || closing) fail('RUN_ALREADY_STARTED');
    // Reserve synchronously before awaiting so even two local callers cannot launch twice.
    status = 'starting';
    if (await exists(outputPath) || await exists(`${outputPath}.manifest.json`)) { status = 'failed'; fail('OUTPUT_EXISTS'); }
    startedAtMs = Date.now(); status = 'running';
    try {
      proc = spawnImpl(process.execPath, ['--use-system-ca', EVALUATOR, '--live', '--env-file', resolve(envFile),
        '--output', outputPath, '--budget-usd', '5', '--max-requests', '80'],
      { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      proc.once('error', () => { status = 'failed'; finishedAtMs = Date.now(); });
      proc.once('exit', code => { if (!closing) status = code === 0 ? 'complete' : code === 2 ? 'stopped' : 'failed'; finishedAtMs = Date.now(); proc = null; });
    } catch { status = 'failed'; finishedAtMs = Date.now(); fail('EVALUATOR_FAILED'); }
  };
  let address;
  const http = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (![address, `localhost:${http.address().port}`].includes(request.headers.host)) { response.writeHead(403); response.end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    const path = request.url;
    if (path !== '/' && path !== '/api/status') { response.writeHead(404); response.end(); return; }
    try {
      const body = path === '/' ? html : JSON.stringify(await getState());
      response.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(503); response.end(); }
  });
  await new Promise((done, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', done); });
  address = `127.0.0.1:${http.address().port}`;
  const close = async () => {
    if (closing) return; closing = true;
    if (proc) { proc.kill('SIGTERM'); proc = null; }
    http.closeAllConnections(); await new Promise(done => http.close(done));
  };
  return { url: `http://${address}/`, outputPath, getState, startRun, close };
}

export function parseDemoArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--run-id', '--env-file', '--port', '--run'].includes(arg) || Object.hasOwn(options, arg)) fail('INVALID_ARGUMENTS');
    if (arg === '--run') options[arg] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS'); options[arg] = argv[++i]; }
  }
  return { runId: options['--run-id'], envFile: options['--env-file'], port: Number(options['--port'] ?? 8786), run: options['--run'] === true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseDemoArguments(process.argv.slice(2)), server = await createLiveDemoServer(options);
    process.stdout.write(`Dashboard: ${server.url}\nType run + Enter to start the real paid comparison; type quit to close.\n`);
    const terminal = createInterface({ input: process.stdin });
    const close = async () => { terminal.close(); await server.close(); };
    terminal.on('line', async line => {
      if (line.trim() === 'quit') await close();
      else if (line.trim() === 'run') try { await server.startRun(); process.stdout.write('Evaluation started. Read-only dashboard is live.\n'); }
      catch { process.stdout.write('Run could not start; use a fresh run ID.\n'); }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);
    if (options.run) await server.startRun();
  } catch { process.stderr.write('Demo server could not start. Check arguments, port and unused run ID.\n'); process.exitCode = 2; }
}
