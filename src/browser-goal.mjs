import { createCuaSession, runGoalWorkflow, prepareGoalPlan, loadApiKey } from './index.mjs';
import { createPlaywrightTarget } from './playwright.mjs';

const now = () => globalThis.performance?.now() ?? Date.now();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const API_KEYS = new Set(['timeoutMs', 'maxCalls', 'maxInputBytes', 'minConfidence', 'minMargin']);
function apiOptions(value, maxSteps) {
  if (value !== undefined && (!record(value) || Object.keys(value).some(key => !API_KEYS.has(key)))) return null;
  const options = { timeoutMs: 5000, maxCalls: Math.min(50, maxSteps + 3), maxInputBytes: 24000,
    minConfidence: 0.75, minMargin: 0.10, ...value };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60000
    || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 1000
    || !Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1 || options.maxInputBytes > 1000000
    || !Number.isFinite(options.minConfidence) || options.minConfidence < 0.75 || options.minConfidence > 1
    || !Number.isFinite(options.minMargin) || options.minMargin < 0.10 || options.minMargin > 1) return null;
  return options;
}

/** A fresh isolated context, with no profile attachment and no effects before validation. */
export async function runBrowserGoal({ plan, apiKey, envFile, channel = 'chrome', headless = false, playwrightImpl, decider } = {}) {
  const started = now();
  const timing = { setupMs: 0, loopMs: 0, teardownMs: 0, totalMs: 0 };
  const mode = decider === undefined ? 'live-jev' : 'injected-decider';
  const handback = reason => ({ status: 'needs_host', reason, completedSteps: 0, steps: [] });
  const early = reason => { timing.setupMs = timing.totalMs = Math.max(0, now() - started); return { mode, ...handback(reason), timing }; };
  if (!record(plan)) return early('INVALID_PLAN');
  const prepared = prepareGoalPlan(plan);
  if (!prepared || (decider !== undefined && typeof decider?.decide !== 'function')) return early('INVALID_PLAN');
  let url;
  try { url = new URL(plan.url); } catch { return early('INVALID_START_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (prepared.allowedOrigins && !prepared.allowedOrigins.includes(url.origin))) return early('INVALID_START_URL');
  if (!['chrome', 'msedge', 'chromium'].includes(channel) || typeof headless !== 'boolean') return early('INVALID_BROWSER_OPTIONS');
  const api = apiOptions(plan.api, prepared.maxSteps);
  if (!api) return early('INVALID_API_OPTIONS');
  let session;
  try {
    if (!decider) {
      const key = await loadApiKey({ apiKey, envFile });
      if (!key) return early('MISSING_API_KEY');
      if (/[\r\n]/.test(key)) return early('JEV_CONFIG_INVALID');
      session = await createCuaSession({ apiKey: key, ...api });
    }
  } catch { return early('JEV_CONFIG_READ_ERROR'); }
  let driver;
  try { driver = playwrightImpl ?? await import('playwright-core'); }
  catch { return early('PLAYWRIGHT_NOT_INSTALLED'); }
  let browser, result;
  const remaining = () => prepared.maxDurationMs - (now() - started);
  try {
    if (remaining() <= 0) return early('TIMEOUT');
    browser = await driver.chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless,
      timeout: Math.max(1, Math.min(30000, remaining())) });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(1, Math.min(5000, remaining())));
    if (remaining() <= 0) result = handback('TIMEOUT');
    else {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(15000, remaining())) });
      timing.setupMs = Math.max(0, now() - started);
      if (remaining() <= 0) result = handback('TIMEOUT');
      else {
        const loopStarted = now();
        try {
          const maxDurationMs = remaining();
          const options = { ...prepared, maxDurationMs, verificationTimeoutMs: Math.min(prepared.verificationTimeoutMs, maxDurationMs),
            allowedOrigins: prepared.allowedOrigins ?? [url.origin], target: createPlaywrightTarget(page) };
          result = decider ? await runGoalWorkflow({ ...options, decider }) : await session.goal(options);
        } finally { timing.loopMs = Math.max(0, now() - loopStarted); }
      }
    }
  } catch { result = handback('BROWSER_FAILED'); }
  finally {
    if (!timing.setupMs) timing.setupMs = Math.max(0, now() - started - timing.loopMs);
    const closeStarted = now();
    if (browser) {
      try { await browser.close(); }
      catch { result = { ...result, status: 'needs_host', reason: 'BROWSER_CLOSE_FAILED' }; }
    }
    timing.teardownMs = Math.max(0, now() - closeStarted);
    timing.totalMs = Math.max(0, now() - started);
  }
  // Flush after freezing workflow timing; never turn measurement into a second API request.
  const billing = session ? await session.flushBilling() : undefined;
  return { mode, ...result, ...(session ? { usage: session.stats(), billing, apiLimits: api } : {}), timing };
}
