import { createCuaSession, runCuaWorkflow, loadApiKey } from './index.mjs';
import { createPlaywrightTarget } from './playwright.mjs';
import { prepareWorkflowPlan } from './cua.mjs';

/** Runs in a new isolated browser context; never imports a personal browser profile. */
export async function runBrowserPlan({ plan, apiKey, envFile, channel = 'chrome', headless = false, playwrightImpl, selector } = {}) {
  const handback = reason => ({ status: 'needs_host', reason, completedSteps: 0 });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return handback('INVALID_PLAN');
  const prepared = prepareWorkflowPlan({
    goal: plan.goal, steps: plan.steps, maxSteps: plan.maxSteps, maxDurationMs: plan.maxDurationMs,
    verificationTimeoutMs: plan.verificationTimeoutMs === undefined ? 1000 : plan.verificationTimeoutMs,
    reuseVerifiedObservation: plan.reuseVerifiedObservation,
  });
  if (!prepared || (selector !== undefined && (!selector || typeof selector.select !== 'function'))) return handback('INVALID_PLAN');
  let url;
  try { url = new URL(plan.url); } catch { return handback('INVALID_START_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return handback('INVALID_START_URL');
  if (!['chrome', 'msedge', 'chromium'].includes(channel) || typeof headless !== 'boolean') return handback('INVALID_BROWSER_OPTIONS');
  let session;
  try {
    if (!selector) {
      const key = await loadApiKey({ apiKey, envFile });
      if (!key) return handback('MISSING_API_KEY');
      session = await createCuaSession({ apiKey: key, maxCalls: 50 });
    }
  } catch { return handback('JEV_CONFIG_READ_ERROR'); }
  let driver;
  try { driver = playwrightImpl ?? await import('playwright-core'); }
  catch { return handback('PLAYWRIGHT_NOT_INSTALLED'); }
  let browser;
  try {
    browser = await driver.chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const options = { target: createPlaywrightTarget(page), ...prepared };
    const result = selector ? await runCuaWorkflow({ ...options, selector }) : await session.workflow(options);
    return { mode: selector ? 'injected-selector' : 'live-jev', ...result, ...(session ? { usage: session.stats() } : {}) };
  } catch { return handback('BROWSER_FAILED'); }
  finally { await browser?.close().catch(() => {}); }
}
