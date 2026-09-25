// Benchmark harness: a host such as Claude Code launches ONE bounded JEV goal loop in an isolated
// headless browser and reads the result. The browser loop runs in Node, so the host model is not in
// the per-step loop. Site preparation (closing known pop-ups) is identical to the other arms and untimed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCuaSession, prepareGoalPlan, runGoalWorkflow, loadApiKey } from '../src/index.mjs';
import { createPlaywrightTarget } from '../src/playwright.mjs';
import { prepareHsmuHome } from './hsmu-browser-setup.mjs';

/** Pre-registered settings for this arm; the JEV limits equal the Claude in Chrome bridge's. */
export const PLAYWRIGHT_ARM = Object.freeze({
  channel: 'chrome', headless: true, settleMs: 2000, gotoTimeoutMs: 20000,
  // Playwright's click also waits, within this timeout, for a navigation it triggers to commit
  // (30 s as in the repository's earlier HSMU Playwright run).
  actionTimeoutMs: 30000,
  // After each click, never replaying it: wait for DOMContentLoaded when the click created a new document
  // (HSMU), then the Claude in Chrome bridge's 1 s post-click wait, then poll read-only until two
  // consecutive captures have the same URL, title and elements (GitHub renders same-document
  // navigations late), capped at 10 s.
  loadStateTimeoutMs: 30000, postClickMs: 1000, stablePollMs: 250, stableCapMs: 10000,
  api: Object.freeze({ timeoutMs: 5000, maxInputBytes: 100000, minConfidence: 0.75, minMargin: 0.10 }),
  verificationTimeoutMs: 30000, maxStaleReplans: 2,
});
const PREPARERS = Object.freeze({ none: null, 'hsmu-popups': prepareHsmuHome });
const now = () => performance.now();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ms = value => Math.max(0, Math.round(value));
const sleep = delay => new Promise(done => setTimeout(done, delay));
const originOf = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null; } catch { return null; } };
const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;

/**
 * Runs one attempt. Returns { result, finalText }; finalText is only set when the loop completed.
 * `decider`, `playwrightImpl`, `preparers`, `fetchImpl`, `settleMs`, `postClickMs`, `stablePollMs` and `apiKey` are injection points for offline tests.
 */
export async function runPlaywrightGoal({ plan, start, prepare = 'none', envFile, apiKey, playwrightImpl, decider, preparers = PREPARERS,
  fetchImpl, settleMs = PLAYWRIGHT_ARM.settleMs, postClickMs = PLAYWRIGHT_ARM.postClickMs, stablePollMs = PLAYWRIGHT_ARM.stablePollMs } = {}) {
  const started = now();
  const timing = { setupMs: 0, prepareMs: 0, loopMs: 0, finalReadMs: 0, teardownMs: 0, totalMs: 0 };
  const stop = (reason, extra = {}) => ({ status: 'needs_host', reason, completedSteps: 0, steps: [], ...extra });
  const finish = (result, finalText = null, extra = {}) => {
    timing.totalMs ||= ms(now() - started);
    return { result: { schemaVersion: 1, arm: 'opus+jev-playwright', settings: PLAYWRIGHT_ARM, start: typeof start === 'string' ? start : null,
      prepare: typeof prepare === 'string' ? prepare : null, ...result, ...extra, timing }, finalText };
  };
  // The arm's verification window and replan count replace the plan's; a shorter task deadline caps the window.
  const planDuration = record(plan) && Number.isFinite(plan.maxDurationMs) ? plan.maxDurationMs : 60000;
  const prepared = record(plan) ? prepareGoalPlan({ ...plan, verificationTimeoutMs: Math.min(PLAYWRIGHT_ARM.verificationTimeoutMs, planDuration),
    maxStaleReplans: PLAYWRIGHT_ARM.maxStaleReplans }) : null;
  if (!prepared || (decider !== undefined && typeof decider?.decide !== 'function')) return finish(stop('INVALID_PLAN'));
  const startOrigin = originOf(start);
  if (!startOrigin || (prepared.allowedOrigins && !prepared.allowedOrigins.includes(startOrigin))) return finish(stop('INVALID_START_URL'));
  if (!Object.hasOwn(preparers, prepare)) return finish(stop('INVALID_PREPARE'));
  const maxCalls = Math.min(50, prepared.maxSteps + 3);

  let session;
  if (!decider) {
    let key;
    try { key = await loadApiKey({ apiKey, envFile }); } catch { return finish(stop('JEV_CONFIG_READ_ERROR')); }
    if (!key) return finish(stop('MISSING_API_KEY'));
    if (/[\r\n]/.test(key)) return finish(stop('JEV_CONFIG_INVALID'));
    session = await createCuaSession({ apiKey: key, maxCalls, ...PLAYWRIGHT_ARM.api, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  let driver;
  try { driver = playwrightImpl ?? await import('playwright-core'); } catch { return finish(stop('PLAYWRIGHT_NOT_INSTALLED')); }

  let browser, result, finalText = null, finalUrl = null, finalReadError = null, prepareEvidence = null, teardownError = null;
  const visitedUrls = [], observations = [], settles = [];
  try {
    browser = await driver.chromium.launch({ channel: PLAYWRIGHT_ARM.channel, headless: PLAYWRIGHT_ARM.headless, timeout: 30000 });
    const context = await browser.newContext(); // fresh, isolated: no profile, cookies or storage state
    const page = await context.newPage();
    page.setDefaultTimeout(PLAYWRIGHT_ARM.actionTimeoutMs);
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_ARM.gotoTimeoutMs });
    await sleep(settleMs);
    timing.setupMs = ms(now() - started);
    const prepareStarted = now();
    if (preparers[prepare]) {
      try { prepareEvidence = await preparers[prepare](page); }
      catch (error) { timing.prepareMs = ms(now() - prepareStarted); result = stop('PREPARE_FAILED', { detail: safeCode(error) }); }
    }
    timing.prepareMs = ms(now() - prepareStarted);
    if (!result) {
      const target = createPlaywrightTarget(page);
      const semantic = observation => JSON.stringify([observation.url, observation.title,
        observation.elements.map(({ ref, ...rest }) => JSON.stringify(rest)).sort()]);
      // Read-only settle after a click; a failed capture here is retried, never turned into an action.
      const waitForStable = async () => {
        const began = now(); let previous = null, reads = 0, failures = 0;
        while (now() - began < PLAYWRIGHT_ARM.stableCapMs) {
          let key = null;
          try { key = semantic(await target.getObservation()); reads++; } catch { failures++; }
          if (key !== null && key === previous) return { stable: true, ms: ms(now() - began), reads, failures };
          previous = key;
          await sleep(stablePollMs);
        }
        return { stable: false, ms: ms(now() - began), reads, failures };
      };
      let inflight = null;
      // Record every loop observation (URL and sizes, no page text) so visits and page timing can be graded without trusting the host.
      const observed = { ...target,
        async getObservation() {
          const pending = target.getObservation();
          inflight = pending.then(() => {}, () => {});
          const observation = await pending;
          if (visitedUrls.at(-1) !== observation.url) visitedUrls.push(observation.url);
          observations.push({ url: observation.url, title: String(observation.title ?? '').slice(0, 120),
            elements: observation.elements.length, textChars: observation.text.length });
          return observation;
        },
        async click(ref) {
          await target.click(ref);
          try {
            if (typeof page.waitForLoadState === 'function') await page.waitForLoadState('domcontentloaded', { timeout: PLAYWRIGHT_ARM.loadStateTimeoutMs });
          } catch { throw Object.assign(new Error('ACTION_TIMEOUT'), { code: 'ACTION_TIMEOUT', actionDispatched: true }); }
          await sleep(postClickMs);
          settles.push(await waitForStable());
        },
      };
      const options = { ...prepared, allowedOrigins: prepared.allowedOrigins ?? [startOrigin], target: observed };
      const loopStarted = now();
      try { result = decider ? await runGoalWorkflow({ ...options, decider }) : await session.goal(options); }
      finally { timing.loopMs = ms(now() - loopStarted); }
      // The decider's own 5 s request limit and the task deadline share the reason TIMEOUT; label the first.
      if (result?.reason === 'TIMEOUT' && Number.isFinite(result.durationMs) && result.durationMs < prepared.maxDurationMs) result = { ...result, detail: 'JEV_REQUEST_TIMEOUT' };
      const readStarted = now();
      // A bounded loop timeout can leave a capture in flight; let it settle before the final read.
      // Clear the guard timer afterwards: a pending 30 s timer would keep the process alive after the result is written.
      if (inflight) {
        let guard;
        await Promise.race([inflight, new Promise(done => { guard = setTimeout(done, PLAYWRIGHT_ARM.actionTimeoutMs); })]);
        clearTimeout(guard);
      }
      try {
        const final = await target.getObservation();
        finalUrl = final.url;
        if (visitedUrls.at(-1) !== final.url) visitedUrls.push(final.url);
        if (result.status === 'completed') finalText = final.text;
      } catch (error) { finalReadError = safeCode(error) ?? 'FINAL_READ_FAILED'; }
      timing.finalReadMs = ms(now() - readStarted);
    }
  } catch (error) { result = stop('BROWSER_FAILED', { detail: safeCode(error) }); }
  finally {
    const closeStarted = now();
    if (browser) {
      try { await browser.close(); }
      catch {
        // Keep a stopped loop's own reason; only a completed run becomes a teardown failure.
        teardownError = 'BROWSER_CLOSE_FAILED';
        result = { ...result, status: 'needs_host', reason: result?.status === 'completed' ? 'BROWSER_CLOSE_FAILED' : result?.reason };
        finalText = null;
      }
    }
    timing.teardownMs = ms(now() - closeStarted);
    timing.totalMs = ms(now() - started);
  }
  // Flush after freezing the task timing; never turn measurement into another request.
  const billing = session ? await session.flushBilling() : null;
  const requests = session ? session.billingRecords().map(entry => ({ index: entry.index, model: entry.model, httpStatus: entry.httpStatus,
    latencyMs: entry.latencyMs === null ? null : ms(entry.latencyMs), inputTokens: entry.inputTokens, error: entry.error })) : [];
  return finish(result, finalText, { visitedUrls, finalUrl, finalReadError, teardownError, observations, settles, prepareEvidence, maxCalls,
    effective: { maxSteps: prepared.maxSteps, maxDurationMs: prepared.maxDurationMs, verificationTimeoutMs: prepared.verificationTimeoutMs, maxStaleReplans: prepared.maxStaleReplans },
    jev: session ? { requests: billing.calls, inputTokens: billing.inputTokens, estimatedJevUsd: billing.estimatedJevUsd,
      knownInputTokens: billing.knownInputTokens, knownUsageUsd: billing.knownUsageUsd, errors: billing.errors,
      pendingRequests: billing.pendingRequests, complete: billing.complete, perRequest: requests } : null });
}

export function parseArguments(argv) {
  const allowed = new Set(['--plan', '--start', '--prepare', '--out', '--env-file']);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(options, flag)) throw new Error('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  if (!options['--plan'] || !options['--start'] || !options['--out']) throw new Error('INVALID_ARGUMENTS');
  return options;
}

/** CLI: writes result.json (and final-text.txt when completed) into a NEW --out directory. */
export async function main(argv, dependencies = {}) {
  const options = parseArguments(argv);
  const out = resolve(options['--out']);
  await mkdir(out, { recursive: false }); // refuses an existing directory, so attempts never mix
  let plan;
  try { const parsed = JSON.parse(await readFile(resolve(options['--plan']), 'utf8')); plan = record(parsed?.plan) ? parsed.plan : parsed; }
  catch { plan = null; }
  const { result, finalText } = await runPlaywrightGoal({ plan, start: options['--start'], prepare: options['--prepare'] ?? 'none',
    envFile: options['--env-file'], ...dependencies });
  if (finalText !== null) await writeFile(join(out, 'final-text.txt'), finalText, 'utf8');
  const written = { ...result, finalTextFile: finalText !== null ? join(out, 'final-text.txt') : null };
  await writeFile(join(out, 'result.json'), JSON.stringify(written, null, 2) + '\n', 'utf8');
  return written;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const written = await main(process.argv.slice(2));
    console.log(JSON.stringify(written, null, 2));
    process.exitCode = written.status === 'completed' ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: ['INVALID_ARGUMENTS'].includes(error?.message) ? error.message : error?.code === 'EEXIST' ? 'OUT_EXISTS' : 'HARNESS_ERROR' }));
    process.exitCode = 1;
  }
}
