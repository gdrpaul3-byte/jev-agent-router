#!/usr/bin/env node
// Render only observed browser JPEGs on the measured task clock. No model calls.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTaskClock } from './task-clock-capture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('INVALID_TASK_CLOCK'); };
export function taskFramePlan(manifest, report) {
  const start = manifest?.taskStart?.wallTimeMs, duration = manifest?.durationMs;
  if (manifest?.schemaVersion !== 1 || manifest.status !== 'aligned' || manifest.width !== 1600 || manifest.height !== 900
    || manifest.timestampBasis !== 'browser-presentation-unix-epoch-ms'
    || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || duration > 240000
    || !Number.isFinite(manifest.clockDriftMs) || Math.abs(manifest.clockDriftMs) > 50
    || manifest.coverage?.initialFrameAtOrBeforeStart !== true || manifest.coverage.activeThroughTaskEnd !== true
    || report?.status !== 'completed' || Math.abs(report.timing?.taskDurationMs - duration) > 0.001
    || !Number.isFinite(report.timing?.taskDurationMs)
    || Math.abs(manifest.taskEnd?.monotonicMs - manifest.taskStart?.monotonicMs - duration) > 0.001
    || !Number.isFinite(manifest.taskEnd?.monotonicMs) || !Number.isFinite(manifest.taskStart?.monotonicMs)
    || !Array.isArray(manifest.frames) || !manifest.frames.length || manifest.frames.length > 10000) fail();
  const recomputed = validateTaskClock({ ...manifest, maxClockDriftMs: 50 });
  if (Math.abs(recomputed.durationMs - duration) > 0.001 || Math.abs(recomputed.clockDriftMs - manifest.clockDriftMs) > 0.001) fail();
  let last = -Infinity;
  let totalBytes = 0;
  const names = new Set();
  for (const frame of manifest.frames) {
    if (!/^frames\/\d{6}\.jpg$/.test(frame.file) || names.has(frame.file) || !/^[a-f0-9]{64}$/.test(frame.sha256)
      || !Number.isFinite(frame.timestampMs) || frame.timestampMs < last
      || !Number.isSafeInteger(frame.bytes) || frame.bytes < 4 || frame.bytes > 8 * 1024 * 1024) fail();
    totalBytes += frame.bytes;
    if (totalBytes > 512 * 1024 * 1024) fail();
    names.add(frame.file); last = frame.timestampMs;
  }
  if (manifest.frames[0].timestampMs > start) fail();
  const indices = [], frameCount = Math.ceil(duration / 40);
  let sourceIndex = 0;
  for (let index = 0; index < frameCount; index++) {
    const instant = start + index * 40;
    while (sourceIndex + 1 < manifest.frames.length && manifest.frames[sourceIndex + 1].timestampMs <= instant) sourceIndex++;
    indices.push(sourceIndex);
  }
  return { fps: 25, frameCount, durationSeconds: frameCount / 25, measuredTaskSeconds: duration / 1000,
    taskStartWallTimeMs: start, clockDriftMs: manifest.clockDriftMs, indices,
    presentationQuantizationMs: 40, tailRoundingMs: frameCount * 40 - duration,
    method: 'At taskStart + n*40ms, show the most recently presented browser frame. Preserve all measured waiting and inference time. No interpolation or speedup.' };
}

export async function renderTaskClock({ runDir, outputDir }) {
  const root = resolve(runDir), output = resolve(outputDir), manifestPath = join(root, 'task-clock', 'manifest.json');
  const source = await readFile(manifestPath), manifest = JSON.parse(source), report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  if (report.taskClock?.status !== 'aligned' || report.taskClock?.sha256 !== sha(source)) throw new Error('TASK_CLOCK_HASH_MISMATCH');
  const plan = taskFramePlan(manifest, report), buffers = new Map();
  for (const index of new Set(plan.indices)) {
    const frame = manifest.frames[index], path = join(root, 'task-clock', frame.file), size = await stat(path);
    if (!size.isFile() || size.size !== frame.bytes) throw new Error('FRAME_SIZE_MISMATCH');
    const data = await readFile(path);
    if (sha(data) !== frame.sha256 || data.length !== frame.bytes) throw new Error('FRAME_HASH_MISMATCH');
    buffers.set(index, data);
  }
  await mkdir(output); // New directory only; preserve originals.
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'image2pipe', '-framerate', '25',
    '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-frames:v', String(plan.frameCount), '-c:v', 'libx264', '-preset', 'fast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25', '-fps_mode', 'cfr', '-movflags', '+faststart', join(output, 'task.mp4')],
    { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const done = new Promise((ok, reject) => {
    child.once('error', () => reject(new Error('MEDIA_TOOL_START_FAILED')));
    child.stdin.on('error', () => reject(new Error('MEDIA_PIPE_FAILED')));
    child.once('close', code => code === 0 ? ok() : reject(new Error('MEDIA_ENCODE_FAILED')));
  });
  done.catch(() => {});
  const deadline = setTimeout(() => child.kill(), 240000);
  try {
    for (const index of plan.indices) if (!child.stdin.write(buffers.get(index))) await Promise.race([once(child.stdin, 'drain'), done.then(() => { throw new Error('MEDIA_PIPE_CLOSED'); })]);
    child.stdin.end(); await done;
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
  const { indices, ...timing } = plan;
  const alignment = { schemaVersion: 1, kind: 'browser-task-clock', ...timing, sourceManifestSha256: sha(source),
    taskVideoSha256: sha(await readFile(join(output, 'task.mp4'))),
    sourceFrames: manifest.frames, selectedFrameIndices: indices,
    limitation: '25fps presentation quantization; browser frame delivery may be sparse. This is not a claim of continuous 25fps source capture or subframe synchronization.' };
  await writeFile(join(output, 'alignment.json'), JSON.stringify(alignment, null, 2) + '\n', { flag: 'wx' });
  return { status: 'rendered', frames: plan.frameCount, measuredTaskSeconds: plan.measuredTaskSeconds, clockDriftMs: plan.clockDriftMs };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [runDir, outputDir, extra] = process.argv.slice(2);
    if (!runDir || !outputDir || extra) throw new Error('EXPECTED_RUN_AND_NEW_OUTPUT_DIRECTORY');
    console.log(JSON.stringify(await renderTaskClock({ runDir, outputDir })));
  } catch (error) { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = 1; }
}
