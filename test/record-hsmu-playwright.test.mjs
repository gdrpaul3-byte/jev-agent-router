import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';

const home = 'https://www.hsmu.ac.kr/web/main/index.do';
const urls = [home, home, 'https://www.hsmu.ac.kr/web/contents/HSMU10501000.do',
  'https://www.hsmu.ac.kr/web/contents/HSMU10501000.do', 'https://www.hsmu.ac.kr/web/contents/HSMU10502000.do',
  'https://www.hsmu.ac.kr/web/contents/HSMU10401000.do'];
const headings = ['', '', '총장 인사말', '총장 인사말', '총장 프로필', '오시는길'];
const elements = [{ role: 'link', name: 'H' }, { role: 'link', name: '총장 인사말' },
  { role: 'button', name: '총장 인사말' }, { role: 'link', name: '총장 프로필' }, { role: 'link', name: '오시는 길' }];
const subject = () => import('../benchmarks/record-hsmu-playwright.mjs');
const prepareHome = async () => ({ closedPopupIds: [], modelRequests: 0, includedInTaskTimer: false });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'hsmu-record-test-'));
  t.after(async () => { const absolute = resolve(root); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep)); await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return root;
}
function fixture({ iframeStage = -1 } = {}) {
  let stage = 0, tick = 0; const events = [], options = {};
  const snapshot = () => ({ url: urls[stage], title: headings[stage] || 'HSMU', text: stage === 5 ? '대중교통 이용 시 탑승요금 무료' : `stage ${stage}`,
    headings: headings[stage] ? [headings[stage]] : [], elements: [{ ...elements[Math.min(stage, 4)], ref: stage + 10 }] });
  const target = {
    async getObservation() { events.push(['observe', stage]); if (stage === iframeStage) throw Object.assign(new Error('IFRAMES_UNSUPPORTED'), { code: 'IFRAMES_UNSUPPORTED' });
      const s = snapshot(); return { ...s, headingEvidence: { source: 'visible-dom-headings', url: s.url, title: s.title, headings: s.headings } }; },
    async click(ref) { assert.equal(ref, stage + 10); events.push(['click', stage]); stage++; },
  };
  const page = { async goto(url) { assert.equal(url, home); events.push(['goto']); }, setDefaultTimeout(ms) { options.actionTimeout = ms; },
    video() { return { async saveAs(path) { assert.ok(events.some(([name]) => name === 'context-close')); await writeFile(path, 'actual-video-mock'); events.push(['video-save']); } }; },
    async screenshot({ path }) { await writeFile(path, 'actual-screenshot-mock'); },
    async evaluate() { return snapshot(); },
  };
  const context = { async newPage() { events.push(['new-page']); return page; }, async close() { events.push(['context-close']); } };
  const browser = { version: () => 'Chrome-test', async newContext(value) { options.context = value; return context; }, async close() { events.push(['browser-close']); } };
  const chromium = { async launch(value) { options.launch = value; return browser; } };
  return { events, options, target, page, chromium, now: () => ++tick * 10 };
}

test('strict CLI separates deterministic preflight from paid arms and rejects unsafe or unknown options', async () => {
  const { parseRecordingArgs } = await subject();
  assert.equal(parseRecordingArgs(['--preflight', '--output-dir', 'out']).mode, 'preflight');
  const paid = parseRecordingArgs(['--arm', 'jev', '--output-dir', 'out', '--env-file', 'local.env', '--preflight-report', 'ready.json']);
  assert.equal(paid.maxRequests, 10); assert.equal(paid.budgetUsd, 2);
  for (const args of [[], ['--preflight', '--arm', 'astra', '--output-dir', 'out'], ['--arm', 'foo', '--output-dir', 'out'],
    ['--preflight', '--output-dir', 'out', '--key', 'secret'], ['--preflight', '--output-dir', 'out', '--max-requests', '11'],
    ['--preflight', '--output-dir', 'out', '--output-dir', 'other']]) assert.throws(() => parseRecordingArgs(args), /INVALID_ARGUMENTS/);
});

test('coherent DOM heading evidence is real structured metadata; navigation drift rejects it', async () => {
  const { createHeadingEvidenceTarget } = await subject();
  const observation = { url: urls[2], title: '총장 인사말', text: 'body', elements: [] };
  const metadata = { url: observation.url, title: observation.title, text: observation.text, headings: ['총장 인사말'] };
  let evaluations = 0;
  const page = { async evaluate(fn) { assert.equal(fn.name, 'captureHeadingEvidence'); evaluations++; return metadata; } };
  const wrapped = createHeadingEvidenceTarget(page, { getObservation: async () => observation, click: async () => {} });
  const result = await wrapped.getObservation();
  assert.equal(evaluations, 2); assert.deepEqual(result.elements, []); assert.equal(result.text, 'body');
  assert.deepEqual(result.headingEvidence.headings, ['총장 인사말']); assert.ok(Object.isFrozen(result.headingEvidence));
  const drift = createHeadingEvidenceTarget({ evaluate: async () => ({ ...metadata, url: home }) }, { getObservation: async () => observation, click: async () => {} });
  await assert.rejects(drift.getObservation(), /INCOHERENT_OBSERVATION/);
});

test('heading reads use bounded JSON primitives when the actual page transport drops objects', async () => {
  const { createHeadingEvidenceTarget } = await subject();
  const observation = { url: urls[2], title: '총장 인사말', text: 'body', elements: [] };
  const heading = { innerText: '총장 인사말', parentElement: null, getClientRects: () => [{}], getAttribute: () => null, hasAttribute: () => false };
  const page = { async evaluate(callback) {
    const value = runInNewContext(`(${callback.toString()})()`, { document: { title: observation.title, body: { innerText: observation.text }, querySelectorAll: () => [heading] },
      location: { href: observation.url }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
    return value !== null && typeof value === 'object' ? undefined : value;
  } };
  const target = createHeadingEvidenceTarget(page, { getObservation: async () => observation, click: async () => {} });
  assert.deepEqual((await target.getObservation()).headingEvidence.headings, ['총장 인사말']);
  page.evaluate = async () => 'x'.repeat(100001);
  await assert.rejects(target.getObservation(), /OBSERVATION_TOO_LARGE/);
  page.evaluate = async () => '{SECRET';
  await assert.rejects(target.getObservation(), error => error.code === 'INVALID_OBSERVATION' && !error.message.includes('SECRET'));
});

test('one click waits for new-document readiness before observation, and load failure never replays the click', async () => {
  const { createHeadingEvidenceTarget } = await subject();
  const events = []; let ready = false;
  const observation = { url: urls[2], title: '총장 인사말', text: 'loaded body', elements: [] };
  const target = {
    async click(ref) { assert.equal(ref, 7); events.push('click'); },
    async getObservation() { assert.equal(ready, true); events.push('observation'); return observation; },
  };
  const page = {
    async waitForLoadState(state, options) { assert.deepEqual([state, options], ['domcontentloaded', { timeout: 30000 }]); events.push('document-ready'); ready = true; },
    async evaluate() { assert.equal(ready, true); events.push('heading'); return JSON.stringify({ ...observation, headings: ['총장 인사말'] }); },
  };
  const wrapped = createHeadingEvidenceTarget(page, target);
  await wrapped.click(7); await wrapped.getObservation();
  assert.deepEqual(events, ['click', 'document-ready', 'heading', 'observation', 'heading']);
  events.length = 0; ready = false;
  page.waitForLoadState = async () => { events.push('load-timeout'); throw new Error('ACTION_TIMEOUT'); };
  await assert.rejects(wrapped.click(7), /ACTION_TIMEOUT/);
  assert.deepEqual(events, ['click', 'load-timeout']);
  events.length = 0; target.click = async () => { events.push('click-failed'); throw new Error('STALE_OBSERVATION'); };
  await assert.rejects(wrapped.click(7), /STALE_OBSERVATION/);
  assert.deepEqual(events, ['click-failed']);
});

test('preflight rehearses all five fresh unique refs without keys or model, saves real video and monotonic offsets', async t => {
  const { recordHsmuPlaywright } = await subject(), root = await temporary(t), f = fixture();
  const report = await recordHsmuPlaywright({ mode: 'preflight', outputDir: join(root, 'run') }, {
    chromium: f.chromium, createTarget: () => f.target, prepareHome, now: f.now,
    runComparison: () => assert.fail('No model benchmark in deterministic rehearsal'), fetchImpl: () => assert.fail('No inference'),
  });
  assert.equal(report.status, 'completed'); assert.equal(report.requests, 0); assert.equal(report.mode, 'preflight');
  assert.deepEqual(f.events.filter(([name]) => name === 'click').map(([, stage]) => stage), [0, 1, 2, 3, 4]);
  assert.equal(f.options.launch.headless, false); assert.equal(f.options.launch.channel, 'chrome');
  assert.deepEqual(f.options.context.viewport, { width: 1600, height: 900 });
  assert.deepEqual(f.options.context.recordVideo.size, { width: 1600, height: 900 });
  assert.equal(report.video.saved, true); assert.equal(report.video.file, 'recording.webm');
  assert.equal(report.verification.visits.length, 3); assert.ok(report.verification.visits.every(v => v.headingVerified));
  assert.ok(report.timing.taskEndOffsetMs >= report.timing.taskStartOffsetMs);
  assert.ok(report.timing.setupMs > 0); assert.ok(report.timing.cleanupMs > 0);
  assert.equal(report.timing.totalMs, report.timing.setupMs + report.timing.taskDurationMs + report.timing.cleanupMs);
  assert.match(report.protocol.comparisonHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(report).includes(root));
  assert.equal(JSON.parse(await readFile(join(root, 'run', 'report.json'), 'utf8')).protocol.comparisonHash, report.protocol.comparisonHash);
  await assert.rejects(recordHsmuPlaywright({ mode: 'preflight', outputDir: join(root, 'run') }, { chromium: f.chromium }), /OUTPUT_EXISTS/);
});

test('visible iframe failure is kept as a zero-call diagnostic with raw recording and no retries', async t => {
  const { recordHsmuPlaywright } = await subject(), root = await temporary(t), f = fixture({ iframeStage: 2 });
  const report = await recordHsmuPlaywright({ mode: 'preflight', outputDir: join(root, 'failed') }, { chromium: f.chromium, createTarget: () => f.target, prepareHome, now: f.now });
  assert.equal(report.reason, 'IFRAMES_UNSUPPORTED'); assert.equal(report.requests, 0); assert.equal(report.video.saved, true);
  assert.equal(f.events.filter(([name]) => name === 'click').length, 2);
});

test('paid run requires matching successful preflight and includes runner cost evidence without swallowing failures', async t => {
  const { recordHsmuPlaywright } = await subject(), root = await temporary(t), f = fixture();
  const preflight = await recordHsmuPlaywright({ mode: 'preflight', outputDir: join(root, 'preflight') }, { chromium: f.chromium, createTarget: () => f.target, prepareHome, now: f.now });
  const paid = fixture(); let invoked = 0;
  const report = await recordHsmuPlaywright({ mode: 'benchmark', arm: 'jev', outputDir: join(root, 'paid') }, {
    chromium: paid.chromium, createTarget: () => paid.target, prepareHome, now: paid.now, preflightReport: preflight,
    apiKeys: { typesafe: 'secret-one', openrouter: 'secret-two' },
    runComparison: async ({ arm, budget, target }) => { invoked++; assert.equal(arm, 'jev'); assert.equal(budget.summary().requests, 0); assert.ok(target);
      return { status: 'needs_host', passed: false, reason: 'HTTP_ERROR', requests: 1, cost: { accountedProviderUsd: .002 }, requestEvidence: [{ index: 0, costComplete: true }] }; },
  });
  assert.equal(invoked, 1); assert.equal(report.reason, 'HTTP_ERROR'); assert.equal(report.requests, 1);
  assert.equal(report.result.cost.accountedProviderUsd, .002); assert.equal(report.video.saved, true);
  assert.ok(!JSON.stringify(report).includes('secret-'));
  const blocked = fixture();
  const failure = await recordHsmuPlaywright({ mode: 'benchmark', arm: 'astra', outputDir: join(root, 'blocked') }, {
    chromium: blocked.chromium, createTarget: () => blocked.target, prepareHome, apiKeys: { openrouter: 'test' },
    preflightReport: { ...preflight, protocol: { ...preflight.protocol, comparisonHash: 'a'.repeat(64) } },
    runComparison: () => assert.fail('No paid inference without matching preflight'),
  });
  assert.equal(failure.reason, 'PREFLIGHT_REQUIRED');
});
