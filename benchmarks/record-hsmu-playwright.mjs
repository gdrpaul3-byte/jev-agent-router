// Fresh headed Chrome only. The deterministic rehearsal is never a measured model run.
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createPlaywrightTarget } from '../src/playwright.mjs';
import { matchesActionTarget } from '../src/decider.mjs';
import { loadApiKey } from '../src/config.mjs';
import { createInferenceBudget } from '../src/inference-budget.mjs';
import { HSMU_BROWSER_PLAN, HSMU_EXPECTED_FACTS, runHsmuBrowserComparison } from './hsmu-browser-compare.mjs';
import { prepareHsmuHome } from './hsmu-browser-setup.mjs';
import { createTaskClockCapture } from './task-clock-capture.mjs';

const HOME = 'https://www.hsmu.ac.kr/web/main/index.do';
const VIEWPORT = Object.freeze({ width: 1600, height: 900 });
const PAGES = [
  { id: 'greeting', url: 'https://www.hsmu.ac.kr/web/contents/HSMU10501000.do', heading: '총장 인사말', afterStep: 2 },
  { id: 'profile', url: 'https://www.hsmu.ac.kr/web/contents/HSMU10502000.do', heading: '총장 프로필', afterStep: 4 },
  { id: 'directions', url: 'https://www.hsmu.ac.kr/web/contents/HSMU10401000.do', heading: '오시는 길', afterStep: 5 },
];
const FAILURES = new Set(['INVALID_ARGUMENTS', 'OUTPUT_EXISTS', 'OUTPUT_FAILED', 'PREFLIGHT_REQUIRED', 'MISSING_API_KEY',
  'JEV_CONFIG_READ_ERROR', 'BROWSER_FAILED', 'IFRAMES_UNSUPPORTED', 'OBSERVATION_TOO_LARGE', 'INVALID_OBSERVATION',
  'INCOHERENT_OBSERVATION', 'OUT_OF_SCOPE', 'AMBIGUOUS_TARGET', 'NO_SAFE_TARGET', 'STALE_OBSERVATION',
  'ACTION_FAILED', 'ACTION_TIMEOUT', 'OBSERVATION_FAILED', 'VERIFICATION_FAILED', 'TIMEOUT', 'VIDEO_SAVE_FAILED', 'SYSTEM_CA_REQUIRED',
  'TASK_CLOCK_UNSUPPORTED', 'TASK_CLOCK_START_FAILED', 'TASK_CLOCK_STOP_FAILED', 'TASK_CLOCK_WRITE_FAILED', 'TASK_CLOCK_NO_FRAME',
  'TASK_CLOCK_NO_INITIAL_FRAME', 'TASK_CLOCK_INVALID_FRAME', 'TASK_CLOCK_CAPTURE_LIMIT', 'TASK_CLOCK_DRIFT', 'TASK_CLOCK_MISSING_BOUNDS',
  'TASK_CLOCK_INVALID_BOUNDS', 'TASK_CLOCK_FRAME_TIMELINE', 'TASK_CLOCK_INVALID_STATE', 'TASK_CLOCK_NOT_READY', 'TASK_CLOCK_INVALID_CLOCK']);
const reasonOf = (error, fallback = 'BROWSER_FAILED') => [error?.code, error?.message].find(value => FAILURES.has(value)) ?? fallback;
const failure = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const normalized = text => text.replace(/\s+/g, '').normalize('NFKC');
const safeKey = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value);
const sourceFiles = ['benchmarks/record-hsmu-playwright.mjs', 'benchmarks/hsmu-browser-setup.mjs', 'benchmarks/hsmu-browser-compare.mjs', 'benchmarks/browser-llm-decider.mjs',
  'src/playwright.mjs', 'src/goal.mjs', 'src/decider.mjs', 'src/observation.mjs', 'src/cua.mjs', 'src/structured-llm.mjs', 'src/inference-budget.mjs'];

function settings(options = {}) {
  const { mode, arm, outputDir, maxRequests = 10, budgetUsd = 2, taskClock = false } = options;
  if (!['preflight', 'benchmark'].includes(mode) || (mode === 'benchmark' && !['astra', 'jev'].includes(arm))
    || (mode === 'preflight' && arm !== undefined) || typeof outputDir !== 'string' || !outputDir.trim()
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10
    || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 2 || typeof taskClock !== 'boolean') throw failure('INVALID_ARGUMENTS');
  return { mode, ...(arm ? { arm } : {}), outputDir: resolve(outputDir), maxRequests, budgetUsd, taskClock };
}

export function parseRecordingArgs(args) {
  const values = {}, allowed = new Set(['--preflight', '--arm', '--output-dir', '--env-file', '--preflight-report', '--max-requests', '--budget-usd', '--task-clock']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; if (!allowed.has(flag) || Object.hasOwn(values, flag)) throw failure('INVALID_ARGUMENTS');
    if (flag === '--preflight' || flag === '--task-clock') values[flag] = true;
    else { const value = args[++i]; if (typeof value !== 'string' || !value || value.startsWith('--')) throw failure('INVALID_ARGUMENTS'); values[flag] = value; }
  }
  const preflight = values['--preflight'] === true;
  if ((preflight && (values['--arm'] || values['--env-file'] || values['--preflight-report']))
    || (!preflight && (!values['--arm'] || !values['--env-file'] || !values['--preflight-report']))) throw failure('INVALID_ARGUMENTS');
  const config = settings({ mode: preflight ? 'preflight' : 'benchmark', arm: values['--arm'], outputDir: values['--output-dir'], taskClock: values['--task-clock'] === true,
    maxRequests: values['--max-requests'] === undefined ? 10 : Number(values['--max-requests']), budgetUsd: values['--budget-usd'] === undefined ? 2 : Number(values['--budget-usd']) });
  return { ...config, ...(preflight ? {} : { envFile: values['--env-file'], preflightReport: values['--preflight-report'] }) };
}

// Executed read-only inside the actual page. Headings are never fabricated as AX rows.
function captureHeadingEvidence() {
  const visible = element => {
    if (!element.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(visible)
    .map(element => (element.getAttribute('aria-label') || element.innerText || '').trim()).filter(Boolean);
  // Return a primitive: legacy page globals can break the automation transport's object serialization.
  return JSON.stringify({ url: location.href, title: document.title, text: document.body?.innerText, headings });
}

async function readHeadings(page) {
  const raw = await page.evaluate(captureHeadingEvidence);
  if (typeof raw !== 'string') return raw; // Existing host/test adapters may already return parsed data.
  if (raw.length > 100000) throw failure('OBSERVATION_TOO_LARGE');
  try { return JSON.parse(raw); } catch { throw failure('INVALID_OBSERVATION'); }
}

export function createHeadingEvidenceTarget(page, target = createPlaywrightTarget(page)) {
  return {
    async click(ref) {
      await target.click(ref);
      // Playwright may return after navigation commits, before the new document has a body.
      // Wait for document readiness after that single click; never replay the action.
      if (typeof page.waitForLoadState === 'function') await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    },
    async getObservation() {
      const before = await readHeadings(page);
      const observation = await target.getObservation();
      const after = await readHeadings(page);
      if (!before || !after || ['url', 'title', 'text'].some(key => before[key] !== observation[key] || after[key] !== observation[key])
        || !Array.isArray(after.headings) || after.headings.length > 100
        || !after.headings.every(value => typeof value === 'string' && value.length <= 2000)
        || JSON.stringify(before.headings) !== JSON.stringify(after.headings)) throw failure('INCOHERENT_OBSERVATION');
      return Object.freeze({ ...observation, headingEvidence: Object.freeze({ source: 'visible-dom-headings',
        url: after.url, title: after.title, headings: Object.freeze([...after.headings]) }) });
    },
  };
}

export async function readStableInitialObservation(target, { now = () => performance.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  const deadline = now() + 5000;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try { return await target.getObservation(); }
    catch (error) {
      if ((error?.code ?? error?.message) !== 'INCOHERENT_OBSERVATION' || attempt === 20 || now() >= deadline) throw error;
      onRetry({ attempt, maxAttempts: 20 });
      await wait(Math.min(250, Math.max(0, deadline - now())));
      if (now() >= deadline) throw error;
    }
  }
}

function verifiedPage(observation, page) {
  const evidence = observation.headingEvidence;
  return observation.url === page.url && evidence?.source === 'visible-dom-headings' && evidence.url === observation.url
    && evidence.title === observation.title && evidence.headings.some(value => normalized(value) === normalized(page.heading));
}
async function rehearse(target, emit, now) {
  const started = now(), visits = [], steps = [];
  const observeUntil = async predicate => {
    const deadline = Math.min(started + HSMU_BROWSER_PLAN.maxDurationMs, now() + HSMU_BROWSER_PLAN.verificationTimeoutMs);
    for (;;) {
      if (now() >= deadline) throw failure('VERIFICATION_FAILED');
      const observation = await target.getObservation();
      let url; try { url = new URL(observation.url); } catch { throw failure('INVALID_OBSERVATION'); }
      if (url.origin !== 'https://www.hsmu.ac.kr') throw failure('OUT_OF_SCOPE');
      if (predicate(observation)) return observation;
      await new Promise(resolve => setTimeout(resolve, 50)); // Poll a condition; never replay a click.
    }
  };
  for (const [index, action] of HSMU_BROWSER_PLAN.actions.entries()) {
    const observation = await observeUntil(value => value.elements.some(element => matchesActionTarget(element, action)));
    if (index === 0 && observation.url !== HOME) throw failure('OUT_OF_SCOPE');
    const candidates = observation.elements.filter(element => !element.disabled && !element.protected && matchesActionTarget(element, action));
    if (candidates.length !== 1) throw failure(candidates.length ? 'AMBIGUOUS_TARGET' : 'NO_SAFE_TARGET');
    await target.click(candidates[0].ref);
    steps.push({ actionId: action.id, ref: candidates[0].ref }); emit('rehearsal-action', { actionId: action.id, completedSteps: steps.length });
    const page = PAGES.find(item => item.afterStep === index + 1);
    if (page) {
      await observeUntil(observation => verifiedPage(observation, page));
      visits.push({ id: page.id, url: page.url, urlVerified: true, headingVerified: true, observedOrder: visits.length + 1 });
    }
  }
  const final = await observeUntil(observation => verifiedPage(observation, PAGES[2])
    && HSMU_BROWSER_PLAN.completion.textIncludes.every(text => observation.text.includes(text)));
  return { visits, completedSteps: steps.length, steps, finalUrl: final.url, imageContentsRead: false };
}

async function protocolFor(config, browserVersion) {
  const root = new URL('../', import.meta.url);
  const sources = Object.fromEntries(await Promise.all([...sourceFiles, ...(config.taskClock ? ['benchmarks/task-clock-capture.mjs'] : [])]
    .map(async file => [file, sha(await readFile(new URL(file, root)))])));
  const effective = { schemaVersion: 1, browser: { channel: 'chrome', headless: false, browserVersion, freshContext: true,
    viewport: VIEWPORT, recordVideoSize: VIEWPORT, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    actionTimeoutMs: 30000, navigationTimeoutMs: 30000, ignoreHTTPSErrors: false },
    maxRequests: config.maxRequests, budgetUsd: config.budgetUsd, plan: HSMU_BROWSER_PLAN, expectedFacts: HSMU_EXPECTED_FACTS,
    preparation: 'Close up to eight freshly observed homepage promotional popup close links before the task timer; record all preparation.',
    target: 'playwright-dom-with-coherent-visible-headings',
    ...(config.taskClock ? { taskClock: { enabled: true, api: 'page.screencast.start.onFrame', timestampBasis: 'browser-presentation-unix-epoch-ms',
      size: VIEWPORT, quality: 90, maxClockDriftMs: 50, taskStart: 'Before inference budget creation and task runner; after preparation and ready observation.',
      taskEnd: 'After task runner including final extraction; before screenshot and capture shutdown.',
      initialObservation: 'Retry only incoherent read-only preparation snapshots, up to 20 attempts or 5 seconds; no click or model retry.' } } : {}),
    models: { astra: 'openai/gpt-6-astra', jev: 'jev-1.13.0', finalExtraction: 'openai/gpt-6-astra' },
    sourceHashes: sources };
  const comparisonHash = sha(JSON.stringify(effective));
  return { ...effective, comparisonHash, runHash: sha(JSON.stringify({ comparisonHash, mode: config.mode, arm: config.arm ?? null })) };
}

/** Dependencies are injectable for offline tests. The CLI always uses the real target/runner and global fetch. */
export async function recordHsmuPlaywright(options, dependencies = {}) {
  const config = settings(options), now = dependencies.now ?? (() => performance.now()), started = now();
  const events = [], emit = (stage, extra = {}) => {
    const event = { stage, elapsedMs: Math.max(0, now() - started), ...extra }; events.push(event);
    try { dependencies.onStage?.(event); } catch { /* Recording must not be stopped by a display callback. */ }
  };
  try { await mkdir(config.outputDir); } catch (error) { throw failure(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_FAILED'); }
  let browser, context, page, video, protocol = null, result = null, verification = null, preparation = null, reason = null, saved = false;
  let pageCreationStarted = null, pageCreated = null, taskStarted = null, taskEnded = null, closed = null, budget = null;
  let taskCapture = null, taskClock = null;
  try {
    if (config.mode === 'benchmark') {
      for (const provider of config.arm === 'jev' ? ['typesafe', 'openrouter'] : ['openrouter']) if (!safeKey(dependencies.apiKeys?.[provider])) throw failure('MISSING_API_KEY');
      if (dependencies.preflightReport?.status !== 'completed' || dependencies.preflightReport?.mode !== 'preflight') throw failure('PREFLIGHT_REQUIRED');
    }
    const chromium = dependencies.chromium ?? (await import('playwright-core')).chromium;
    emit('launching'); browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1600,1000'], timeout: 30000 });
    const version = browser.version();
    protocol = await protocolFor(config, /^[a-zA-Z0-9 ._-]{1,80}$/.test(version) ? version : 'unknown');
    await writeFile(join(config.outputDir, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n', { flag: 'wx' });
    if (config.mode === 'benchmark' && dependencies.preflightReport.protocol?.comparisonHash !== protocol.comparisonHash) throw failure('PREFLIGHT_REQUIRED');
    context = await browser.newContext({ viewport: { ...VIEWPORT }, recordVideo: { dir: config.outputDir, size: { ...VIEWPORT } },
      deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', ignoreHTTPSErrors: false });
    pageCreationStarted = now(); page = await context.newPage(); pageCreated = now(); video = page.video();
    if (config.taskClock) {
      taskCapture = createTaskClockCapture(page, join(config.outputDir, 'task-clock'), { now, wallNow: dependencies.wallNow, ...dependencies.taskClockOptions });
      await taskCapture.start();
    }
    page.setDefaultTimeout(30000); await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    preparation = await (dependencies.prepareHome ?? prepareHsmuHome)(page, details => emit('preparation-popup-close', details));
    const base = (dependencies.createTarget ?? createPlaywrightTarget)(page);
    const target = dependencies.createTarget ? base : createHeadingEvidenceTarget(page, base);
    // Initial capture rejects an unsupported visible iframe before any inference.
    const initial = config.taskClock ? await readStableInitialObservation(target, { now,
      onRetry: details => emit('preparation-observation-retry', details) }) : await target.getObservation();
    if (initial.url !== HOME) throw failure('OUT_OF_SCOPE');
    if (taskCapture) await taskCapture.ready();
    emit('ready', { mode: config.mode, arm: config.arm ?? null });
    taskStarted = taskCapture ? taskCapture.markTaskStart().monotonicMs : now(); emit('task-start');
    if (config.mode === 'preflight') verification = await rehearse(target, emit, now);
    else {
      budget = createInferenceBudget({ fetchImpl: dependencies.fetchImpl ?? globalThis.fetch, maxRequests: config.maxRequests, budgetUsd: config.budgetUsd });
      const observedTarget = { getObservation: () => target.getObservation(), async click(ref) { await target.click(ref); emit('browser-action'); } };
      result = await (dependencies.runComparison ?? runHsmuBrowserComparison)({ target: observedTarget, arm: config.arm, apiKeys: dependencies.apiKeys, budget });
      if (!result.passed) reason = result.reason;
    }
    taskEnded = taskCapture ? taskCapture.markTaskEnd().monotonicMs : now(); emit('task-finish', { passed: !reason, requests: result?.requests ?? 0 });
    await page.screenshot({ path: join(config.outputDir, 'final.png'), fullPage: false, timeout: 10000 }).catch(() => {});
  } catch (error) {
    reason = reasonOf(error);
    if (taskStarted !== null && taskEnded === null && taskCapture) {
      try { taskEnded = taskCapture.markTaskEnd().monotonicMs; } catch { /* Invalid capture is reported by stop below. */ }
    }
    taskEnded ??= now(); emit('failed', { reason });
  }
  finally {
    if (taskCapture) {
      try {
        const manifest = await taskCapture.stop();
        taskClock = { file: 'task-clock/manifest.json', sha256: sha(await readFile(join(config.outputDir, 'task-clock', 'manifest.json'))),
          status: manifest.status, reason: manifest.reason, taskStart: manifest.taskStart, taskEnd: manifest.taskEnd,
          durationMs: manifest.durationMs, clockDriftMs: manifest.clockDriftMs, frameCount: manifest.frames.length };
        if (manifest.status !== 'aligned') reason ??= manifest.reason ?? 'TASK_CLOCK_INVALID_BOUNDS';
      } catch (error) { reason ??= reasonOf(error); taskClock = { status: 'invalid', reason: reasonOf(error), file: null }; }
    }
    if (context) { try { await context.close(); } catch { reason ??= 'BROWSER_FAILED'; } }
    closed = now();
    if (video) { try { await video.saveAs(join(config.outputDir, 'recording.webm')); saved = true; } catch { reason ??= 'VIDEO_SAVE_FAILED'; } }
    if (browser) await browser.close().catch(() => { reason ??= 'BROWSER_FAILED'; });
  }
  const finished = now();
  const offset = value => value === null || pageCreated === null ? null : Math.max(0, value - pageCreated);
  const report = { schemaVersion: 1, mode: config.mode, arm: config.arm ?? null, status: reason ? 'failed' : 'completed', reason,
    label: config.mode === 'preflight' ? 'Deterministic five-click rehearsal; no model performance claim' : 'Actual model-selected browser task; fresh isolated headed Chrome',
    protocol, requests: result?.requests ?? budget?.summary().requests ?? 0, result, verification, preparation, events,
    ...(config.taskClock ? { taskClock } : {}),
    timing: { clock: 'monotonic performance.now', setupMs: Math.max(0, (taskStarted ?? taskEnded) - started),
      cleanupMs: Math.max(0, finished - taskEnded), totalMs: Math.max(0, finished - started),
      taskDurationMs: taskStarted === null ? null : Math.max(0, taskEnded - taskStarted),
      taskStartOffsetMs: offset(taskStarted), taskEndOffsetMs: offset(taskEnded), contextCloseOffsetMs: offset(closed),
      pageCreationDurationMs: pageCreated === null ? null : Math.max(0, pageCreated - pageCreationStarted),
      offsetBasis: 'Estimates from newPage completion, not decoded video timestamps; first-frame encoding offset is unknown.' },
    video: { saved, file: saved ? 'recording.webm' : null, width: 1600, height: 900, originalUntrimmed: true },
  };
  await writeFile(join(config.outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  emit('saved', { passed: !reason, videoSaved: saved, requests: report.requests });
  return report;
}

async function boundedRead(path, maxBytes) {
  let file;
  try { file = await open(path, 'r'); const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes) throw failure('JEV_CONFIG_READ_ERROR');
    const bytes = Buffer.alloc(maxBytes + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw failure('JEV_CONFIG_READ_ERROR'); return bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await file?.close().catch(() => {}); }
}
async function main() {
  try {
    const options = parseRecordingArgs(process.argv.slice(2));
    const dependencies = { onStage: event => process.stdout.write(JSON.stringify(event) + '\n') };
    if (options.mode === 'benchmark') {
      if (!process.execArgv.includes('--use-system-ca') && process.env.NODE_USE_SYSTEM_CA !== '1') throw failure('SYSTEM_CA_REQUIRED');
      dependencies.preflightReport = JSON.parse(await boundedRead(options.preflightReport, 1000000));
      const env = parseEnv(await boundedRead(options.envFile, 65536));
      dependencies.apiKeys = { typesafe: await loadApiKey({ apiKey: process.env.TYPESAFE_API_KEY ?? '', envFile: options.envFile }),
        openrouter: (process.env.OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY ?? '').trim() };
    }
    const report = await recordHsmuPlaywright(options, dependencies); process.exitCode = report.status === 'completed' ? 0 : 1;
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', reason: reasonOf(error, 'INVALID_ARGUMENTS') }) + '\n'); process.exitCode = 1; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
