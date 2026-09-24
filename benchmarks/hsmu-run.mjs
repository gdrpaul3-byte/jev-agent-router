import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCuaWorkflow } from '../src/cua.mjs';
import { startRecorder } from './cua-recorder.mjs';

export const homeUrl = 'https://www.hsmu.ac.kr/web/main/index.do';
export const goal = 'Open the university directions page, then return to the main homepage.';
export const steps = [
  { instruction: 'Click the link labeled 오시는 길 to open the university directions page.', action: 'click', expect: { textIncludes: '대중교통 이용 시' } },
  { instruction: 'Click the link named 메인 홈페이지로 이동 to return to the main homepage.', action: 'click', expect: { textIncludes: 'Description: Neo RC' } },
];
const names = new Map([[steps[0].instruction, '오시는 길'], [steps[1].instruction, '메인 홈페이지로 이동']]);
export const directSelector = { async select({ instruction, observation }) {
  const started = performance.now();
  const candidates = observation.elements.filter(item => item.role === 'link' && !item.disabled && item.name === names.get(instruction));
  return candidates.length === 1
    ? { status: 'selected', ref: candidates[0].ref, confidence: 1, latencyMs: performance.now() - started }
    : { status: 'needs_host', reason: 'DIRECT_TARGET_NOT_UNIQUE', latencyMs: performance.now() - started };
} };

export async function prepareStart(target) {
  if (await target.url() !== homeUrl) await target.goto(homeUrl);
  let previous = '', stableSince = performance.now();
  const started = performance.now();
  while (performance.now() - started < 15000) {
    const text = await target.getAXState({ emit: false, disableDiffing: true });
    if (text !== previous) { previous = text; stableSince = performance.now(); }
    if (text.includes('Description: Neo RC') && performance.now() - stableSince >= 2000) return { preparedMs: performance.now() - started };
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('START_STATE_NOT_STABLE');
}

export async function runTrial({ target, selector, root, name, mode }) {
  if (!['direct', 'jev'].includes(mode) || !/^[a-z0-9-]+$/.test(name)) throw new Error('INVALID_TRIAL');
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const before = selector.stats();
  const startedAtEpochMs = Date.now();
  const started = performance.now();
  let result, finalUrl;
  try {
    result = await runCuaWorkflow({ target, selector: mode === 'jev' ? selector : directSelector, goal, steps, maxSteps: 2, maxDurationMs: 30000, verificationTimeoutMs: 5000 });
    finalUrl = await target.url();
  } catch {
    result = { status: 'needs_host', reason: 'BENCHMARK_HOST_ERROR', completedSteps: 0 };
  }
  const ended = performance.now();
  const after = selector.stats();
  const evidence = {
    name, mode, normalMethod: 'preplanned exact-label selection, one batched host call',
    result, finalUrl, success: result.status === 'completed' && finalUrl === homeUrl,
    taskDurationMs: ended - started, startedAtEpochMs, endedAtEpochMs: Date.now(),
    apiCalls: after.calls - before.calls, inputTokens: after.inputTokens - before.inputTokens,
    hostCallsForExecution: 1, timingScope: 'in-host observation, selection, action, verification, final URL; excludes outer model/tool roundtrip and preparation',
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

export async function runRecordedTrial(options) {
  await prepareStart(options.target);
  const directory = join(options.root, options.name);
  const recorder = startRecorder({ capture: () => options.target.getScreenshot({ emit: false }), directory, intervalMs: 500, maxDurationMs: 45000 });
  let evidence;
  try {
    await recorder.ready;
    evidence = await runTrial(options);
  } finally {
    const recording = await recorder.stop();
    if (evidence) {
      evidence.recording = { type: recording.format, startedAt: recording.startedAt, frames: recording.frames.length, durationMs: recording.durationMs, errors: recording.errors };
      await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
  }
  return evidence;
}
