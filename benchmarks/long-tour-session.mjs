import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAX, runCuaWorkflow } from '../src/cua.mjs';

const HOME = 'https://www.hsmu.ac.kr/web/main/index.do';
const MAP = 'https://www.hsmu.ac.kr/web/contents/HSMU90100000.do';
const boardNames = new Set(['학사', '장학', '취업']);

function linkKey(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const raw = value.trim();
    const url = new URL(/^[\w.-]+\.[a-z]+\//i.test(raw) ? `https://${raw}` : raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

function pageDetails(text, url, board = false) {
  const lines = text.split(/\r?\n/);
  const header = lines.find(line => line.startsWith('Browser tab:')) ?? lines[0] ?? '';
  const pageTitle = /Title: "(.*?)", URL:/.exec(header)?.[1] ?? null;
  const headings = lines.filter(line => /\bheading\b/.test(line));
  let start = lines.findIndex(line => /\bheading\b/.test(line) && /Value:\s*3\b/.test(line));
  let contentExcerptSource = 'level-3-heading';
  if (start < 0) { start = lines.findIndex(line => /\bmain\b/.test(line)); contentExcerptSource = 'main'; }
  if (start < 0) { start = 0; contentExcerptSource = 'full-ax-fallback'; }
  const footer = lines.findIndex((line, index) => index > start && /\b(?:contentinfo|footer)\b/.test(line));
  const content = lines.slice(start, footer < 0 ? undefined : footer).join('\n');
  return {
    url, header, pageTitle, headings: headings.slice(0, 20),
    contentTextLength: content.length, contentExcerptSource,
    contentExcerpt: content.slice(0, board ? 6000 : 1200),
    ...(board ? { pageAX: text } : {}),
  };
}

/** State lives in this imported module's closure, not mutable CUA REPL bindings.
 * Call noteBatch once per outer tool batch. Content judgments remain with the host.
 */
export function createTourSession({
  target, mode, selector, outputDir, plan,
  homeUrl = HOME, sitemapUrl = MAP, startUrl = homeUrl,
  maxDurationMs = 600000, stepTimeoutMs = 30000, verificationTimeoutMs = 10000,
} = {}) {
  const visits = Array.isArray(plan) ? plan : plan?.recommendedVisits;
  if (!target || typeof target.getAXState !== 'function' || typeof target.click !== 'function'
    || typeof target.url !== 'function' || !['direct', 'jev'].includes(mode)
    || (mode === 'jev' && typeof selector?.select !== 'function')
    || typeof outputDir !== 'string' || !outputDir.trim()
    || !Array.isArray(visits) || !visits.length
    || visits.some(item => typeof item?.name !== 'string' || typeof item?.url !== 'string')
    || [maxDurationMs, stepTimeoutMs, verificationTimeoutMs].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('INVALID_TOUR_OPTIONS');
  }
  const itinerary = visits.map(({ name, url }) => ({ name, url }));
  const state = {
    version: 1, mode, status: 'created', startedAtEpochMs: null, endedAtEpochMs: null,
    durationMs: null, maxDurationMs, stepTimeoutMs, verificationTimeoutMs,
    homeUrl, sitemapUrl, startUrl, itinerary, toolBatches: [], observations: [], actions: [], visits: [],
    timingScope: 'First AX request through verified home return; includes host interpretation and batch gaps, excludes prior setup and final report.',
    selectionMethod: mode === 'direct'
      ? 'Host chooses itinerary item; fresh observed link name and href select its current ref; natural batching allowed.'
      : 'Host chooses itinerary item; live supplied selector chooses current ref within the bounded workflow.',
  };
  let started = null, lastAX = '', busy = false, beforeStats = null;
  const elapsed = () => started === null ? 0 : performance.now() - started;
  const remaining = () => maxDurationMs - elapsed();
  const checkpoint = () => {
    const afterStats = typeof selector?.stats === 'function' ? selector.stats() : null;
    state.apiCalls = afterStats && beforeStats ? afterStats.calls - beforeStats.calls : 0;
    state.inputTokens = afterStats && beforeStats ? afterStats.inputTokens - beforeStats.inputTokens : 0;
    return writeFile(join(outputDir, 'session.json'), `${JSON.stringify(state, null, 2)}\n`);
  };
  const compact = () => ({
    status: state.status, ...(state.reason ? { reason: state.reason } : {}),
    completedVisits: state.visits.filter(item => item.navigationStatus === 'completed').length,
    assessedVisits: state.visits.filter(item => item.content).length,
    durationMs: state.durationMs ?? elapsed(), outputFile: join(outputDir, 'session.json'),
  });
  const stop = async reason => {
    state.status = 'needs_host'; state.reason = reason;
    state.endedAtEpochMs = Date.now(); state.durationMs = elapsed();
    await checkpoint();
    return compact();
  };
  async function bounded(operation, timeout, reason) {
    const wait = Math.min(timeout, remaining());
    if (wait <= 0) throw new Error('TOUR_TIMEOUT');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), wait); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function observe(phase) {
    const requestedAtEpochMs = Date.now();
    const text = await target.getAXState({ emit: false, disableDiffing: true });
    if (typeof text !== 'string') throw new Error('INVALID_OBSERVATION');
    const number = state.observations.length + 1;
    const file = `observations/${String(number).padStart(4, '0')}-${phase}.txt`;
    state.observations.push({ file, phase, requestedAtEpochMs, receivedAtEpochMs: Date.now(), elapsedMs: elapsed() });
    await writeFile(join(outputDir, file), text);
    lastAX = text;
    return text;
  }
  async function operation(callback) {
    if (busy) return { status: 'needs_host', reason: 'SESSION_BUSY' };
    if (state.status !== 'running') return compact();
    if (remaining() <= 0) return stop('TOUR_TIMEOUT');
    busy = true;
    try { return await callback(); }
    catch (error) {
      const allowed = ['TOUR_TIMEOUT', 'OBSERVATION_TIMEOUT', 'URL_TIMEOUT', 'INVALID_OBSERVATION'];
      return await stop(allowed.includes(error.message) ? error.message : 'HOST_OPERATION_FAILED');
    } finally { busy = false; }
  }
  function directSelectorFor(destination) {
    return { async select({ observation }) {
      const startedSelection = performance.now();
      let candidates = observation.elements.filter(item => item.role === 'link' && !item.disabled
        && linkKey(item.value, homeUrl) === linkKey(destination.url, homeUrl));
      if (destination.kind === 'home') {
        const breadcrumb = candidates.filter(item => item.name === '메인 홈페이지로 이동');
        if (breadcrumb.length) candidates = breadcrumb;
      } else {
        candidates = candidates.filter(item => item.name === destination.name || item.description === destination.name);
      }
      return candidates.length === 1
        ? { status: 'selected', ref: candidates[0].ref, confidence: 1, latencyMs: performance.now() - startedSelection }
        : { status: 'needs_host', reason: 'DIRECT_TARGET_NOT_UNIQUE', latencyMs: performance.now() - startedSelection };
    } };
  }
  async function navigate(destination) {
    const action = { kind: destination.kind, ...(destination.index === undefined ? {} : { index: destination.index }),
      name: destination.name, expectedUrl: destination.url, startedAtEpochMs: Date.now(), status: 'running' };
    state.actions.push(action);
    const phase = `${String(state.actions.length).padStart(2, '0')}-${destination.kind}`;
    const workflowTarget = {
      getAXState: () => observe(phase),
      click: ref => target.click(ref),
    };
    action.workflow = await runCuaWorkflow({
      target: workflowTarget,
      selector: mode === 'jev' ? selector : directSelectorFor(destination),
      goal: 'Visit the requested public university page, inspect its content, and follow the host-provided tour order.',
      steps: [{
        instruction: destination.kind === 'home'
          ? `Click the observed homepage link whose destination is ${destination.url}. Prefer the link named 메인 홈페이지로 이동 if present; otherwise choose the observed university homepage link. Perform only this current navigation step.`
          : `Click the observed link named ${JSON.stringify(destination.name)} whose destination is ${destination.url}. Perform only this current navigation step.`,
        action: 'click', expect: { textIncludes: `URL: "${destination.url}"` },
      }],
      maxSteps: 1, maxDurationMs: Math.min(stepTimeoutMs, remaining()), verificationTimeoutMs,
    });
    action.endedAtEpochMs = Date.now();
    action.status = action.workflow.status;
    if (action.workflow.status !== 'completed') {
      action.reason = action.workflow.reason;
      return stop(action.reason);
    }
    action.actualUrl = await bounded(() => target.url(), verificationTimeoutMs, 'URL_TIMEOUT');
    if (action.actualUrl !== destination.url) { action.status = 'needs_host'; action.reason = 'URL_MISMATCH'; return stop(action.reason); }
    state.currentUrl = action.actualUrl;
    if (remaining() <= 0) return stop('TOUR_TIMEOUT');
    const details = pageDetails(lastAX, action.actualUrl, boardNames.has(destination.name));
    const observationFile = state.observations.at(-1)?.file;
    if (destination.kind === 'visit') {
      const entry = { index: destination.index, name: destination.name, navigationStatus: 'completed',
        url: details.url, header: details.header, pageTitle: details.pageTitle, headings: details.headings,
        contentTextLength: details.contentTextLength, contentExcerptSource: details.contentExcerptSource, observationFile, content: null };
      state.visits.push(entry);
    }
    await checkpoint();
    return { status: 'completed', ...(destination.index === undefined ? {} : { index: destination.index }),
      ...details, observationFile, workflow: action.workflow };
  }
  async function visit(index) {
    return operation(async () => {
      if (!Number.isInteger(index) || !itinerary[index]) return stop('INVALID_VISIT_INDEX');
      if (state.currentUrl !== sitemapUrl) return stop('VISIT_REQUIRES_SITEMAP');
      if (state.visits.some(item => item.index === index)) return stop('VISIT_ALREADY_RECORDED');
      return navigate({ kind: 'visit', index, ...itinerary[index] });
    });
  }
  return {
    async start() {
      if (state.status !== 'created') return compact();
      await mkdir(join(outputDir, 'observations'), { recursive: true });
      beforeStats = typeof selector?.stats === 'function' ? selector.stats() : null;
      state.status = 'running'; started = performance.now(); state.startedAtEpochMs = Date.now();
      return operation(async () => {
        const text = await bounded(() => observe('start'), verificationTimeoutMs, 'OBSERVATION_TIMEOUT');
        parseAX(text);
        const url = await bounded(() => target.url(), verificationTimeoutMs, 'URL_TIMEOUT');
        if (url !== startUrl) return stop('START_URL_MISMATCH');
        state.currentUrl = url;
        await checkpoint();
        return { ...compact(), ...pageDetails(text, url), pageAX: text };
      });
    },
    async noteBatch(label = '') {
      if (state.status !== 'running') return compact();
      state.toolBatches.push({ number: state.toolBatches.length + 1, label: String(label).slice(0, 200),
        atEpochMs: Date.now(), elapsedMs: elapsed() });
      await checkpoint();
      return { batch: state.toolBatches.length, ...compact() };
    },
    openMap() { return operation(() => navigate({ kind: 'map', name: 'SITEMAP', url: sitemapUrl })); },
    returnToMap() { return operation(() => navigate({ kind: 'map', name: 'SITEMAP', url: sitemapUrl })); },
    visit,
    directVisit(index) { return mode === 'direct' ? visit(index) : Promise.resolve({ status: 'needs_host', reason: 'WRONG_MODE' }); },
    jevVisit(index) { return mode === 'jev' ? visit(index) : Promise.resolve({ status: 'needs_host', reason: 'WRONG_MODE' }); },
    async markContent(index, { loaded, title, latestNotice, reason } = {}) {
      return operation(async () => {
        const entry = state.visits.find(item => item.index === index);
        if (!entry || entry.content || typeof loaded !== 'boolean') return stop('INVALID_CONTENT_ASSESSMENT');
        if (latestNotice !== undefined && (latestNotice === null || typeof latestNotice !== 'object'
          || typeof latestNotice.title !== 'string' || typeof latestNotice.date !== 'string')) return stop('INVALID_NOTICE_ASSESSMENT');
        entry.content = { loaded, ...(title === undefined ? {} : { title: String(title) }),
          ...(latestNotice === undefined ? {} : { latestNotice: { title: latestNotice.title, date: latestNotice.date,
            ...(typeof latestNotice.url === 'string' ? { url: latestNotice.url } : {}) } }),
          ...(reason === undefined ? {} : { reason: String(reason) }), assessedAtEpochMs: Date.now() };
        await checkpoint();
        if (!loaded) return stop('CONTENT_NOT_LOADED');
        return { ...compact(), assessmentStatus: 'recorded', index, content: entry.content };
      });
    },
    async finish() {
      return operation(async () => {
        if (state.visits.length !== itinerary.length || state.visits.some(item => !item.content?.loaded)) return stop('CONTENT_ASSESSMENT_INCOMPLETE');
        if (state.visits.some(item => boardNames.has(item.name) && !item.content.latestNotice)) return stop('NOTICE_ASSESSMENT_INCOMPLETE');
        const result = await navigate({ kind: 'home', name: '메인 홈페이지로 이동', url: homeUrl });
        if (result.status !== 'completed') return result;
        state.status = 'completed'; state.endedAtEpochMs = Date.now(); state.durationMs = elapsed();
        await checkpoint();
        return compact();
      });
    },
    snapshot() { return JSON.parse(JSON.stringify({ ...state, durationMs: state.durationMs ?? elapsed() })); },
  };
}
