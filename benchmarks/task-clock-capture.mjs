// Public Playwright screencast frames retain browser presentation timestamps.
// Frame delivery is event-driven: an unchanged page can legitimately have long gaps.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_LIMITS = Object.freeze({ maxFrames: 10000, maxBytes: 512 * 1024 * 1024,
  maxFrameBytes: 8 * 1024 * 1024, maxPendingBytes: 16 * 1024 * 1024 });
const finite = value => Number.isFinite(value) && value >= 0;
const MAX_DELIVERY_BACKSTEP_MS = 1000;

export function clockPoint(now = () => performance.now(), wallNow = Date.now) {
  const monotonicMs = now(), wallTimeMs = wallNow();
  if (!finite(monotonicMs) || !finite(wallTimeMs)) throw fail('TASK_CLOCK_INVALID_CLOCK');
  return { wallTimeMs, monotonicMs };
}

export function validateTaskClock({ taskStart, taskEnd, captureStarted, captureStopped, frames, maxClockDriftMs = 50 }) {
  const points = [taskStart, taskEnd, captureStarted, captureStopped];
  if (!points.every(point => point && finite(point.wallTimeMs) && finite(point.monotonicMs))) throw fail('TASK_CLOCK_MISSING_BOUNDS');
  const durationMs = taskEnd.monotonicMs - taskStart.monotonicMs;
  if (!(durationMs > 0) || taskStart.monotonicMs < captureStarted.monotonicMs
    || taskEnd.monotonicMs > captureStopped.monotonicMs) throw fail('TASK_CLOCK_INVALID_BOUNDS');
  const clockDriftMs = Math.abs((taskEnd.wallTimeMs - taskStart.wallTimeMs) - durationMs);
  const allDrift = points.map(point => Math.abs((point.wallTimeMs - captureStarted.wallTimeMs)
    - (point.monotonicMs - captureStarted.monotonicMs)));
  if (!finite(maxClockDriftMs) || clockDriftMs > maxClockDriftMs || allDrift.some(value => value > maxClockDriftMs)) throw fail('TASK_CLOCK_DRIFT');
  if (!Array.isArray(frames) || !frames.length || !frames.some(frame => finite(frame.timestampMs) && frame.timestampMs <= taskStart.wallTimeMs)
    || frames.some((frame, index) => !finite(frame.timestampMs) || frame.timestampMs > captureStopped.wallTimeMs + maxClockDriftMs
      || (index > 0 && frame.timestampMs < frames[index - 1].timestampMs))) throw fail('TASK_CLOCK_FRAME_TIMELINE');
  return { durationMs, clockDriftMs, coverage: { initialFrameAtOrBeforeStart: true, activeThroughTaskEnd: true } };
}

export function createTaskClockCapture(page, outputDir, options = {}) {
  const now = options.now ?? (() => performance.now()), wallNow = options.wallNow ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)) throw fail('TASK_CLOCK_INVALID_LIMITS');
  const frames = [], writes = new Set();
  let captureStarted = null, captureStopped = null, taskStart = null, taskEnd = null;
  let reason = null, active = false, started = false, stopped = false, totalBytes = 0, pendingBytes = 0, manifest = null, invalidFrame = null;
  let greatestTimestampMs = null, timestampRegressions = 0, maxBackstepMs = 0;
  const invalidate = code => { reason ??= code; };
  const assertValid = () => { if (reason) throw fail(reason); };
  const point = () => clockPoint(now, wallNow);

  function onFrame(frame) {
    if (!active || reason) return;
    const data = frame?.data, timestampMs = frame?.timestamp, receivedAtWallTimeMs = wallNow();
    const isBuffer = Buffer.isBuffer(data), issues = [];
    if (!isBuffer) issues.push('not-buffer');
    else if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) issues.push('not-jpeg');
    if (frame?.viewportWidth !== 1600 || frame?.viewportHeight !== 900) issues.push('viewport-mismatch');
    if (!finite(timestampMs) || timestampMs < 1e12) issues.push('invalid-timestamp');
    if (timestampMs > receivedAtWallTimeMs + 50) issues.push('future-timestamp');
    const backstepMs = greatestTimestampMs === null ? 0 : Math.max(0, greatestTimestampMs - timestampMs);
    if (backstepMs > MAX_DELIVERY_BACKSTEP_MS) issues.push('timestamp-regression-exceeds-limit');
    if (issues.length) {
      // Only bounded numeric metadata, never arbitrary provider text or image bytes.
      invalidFrame = { issues, receivedAtWallTimeMs, timestampMs: finite(timestampMs) ? timestampMs : null,
        timestampMinusReceiveMs: finite(timestampMs) ? timestampMs - receivedAtWallTimeMs : null,
        previousTimestampMs: frames.at(-1)?.timestampMs ?? null, isBuffer, bytes: isBuffer ? data.length : null,
        greatestTimestampMs,
        jpegPrefixValid: isBuffer && data[0] === 0xff && data[1] === 0xd8,
        viewportWidth: finite(frame?.viewportWidth) ? frame.viewportWidth : null,
        viewportHeight: finite(frame?.viewportHeight) ? frame.viewportHeight : null };
      invalidate('TASK_CLOCK_INVALID_FRAME'); return;
    }
    if (data.length > limits.maxFrameBytes || frames.length >= limits.maxFrames || totalBytes + data.length > limits.maxBytes
      || pendingBytes + data.length > limits.maxPendingBytes) { invalidate('TASK_CLOCK_CAPTURE_LIMIT'); return; }
    const bytes = Buffer.from(data), file = `frames/${String(frames.length + 1).padStart(6, '0')}.jpg`;
    if (backstepMs > 0) { timestampRegressions++; maxBackstepMs = Math.max(maxBackstepMs, backstepMs); }
    greatestTimestampMs = greatestTimestampMs === null ? timestampMs : Math.max(greatestTimestampMs, timestampMs);
    frames.push({ file, arrivalIndex: frames.length + 1, timestampMs, sha256: hash(bytes), bytes: bytes.length });
    totalBytes += bytes.length; pendingBytes += bytes.length;
    const write = writeFile(join(outputDir, file), bytes, { flag: 'wx' })
      .catch(() => invalidate('TASK_CLOCK_WRITE_FAILED'))
      .finally(() => { pendingBytes -= bytes.length; writes.delete(write); });
    writes.add(write);
    // Do not delay Playwright's frame acknowledgement on disk IO.
  }

  return {
    async start() {
      if (started || stopped) throw fail('TASK_CLOCK_INVALID_STATE');
      started = true;
      await mkdir(join(outputDir, 'frames'), { recursive: true });
      captureStarted = point();
      if (typeof page?.screencast?.start !== 'function' || typeof page?.screencast?.stop !== 'function') {
        invalidate('TASK_CLOCK_UNSUPPORTED'); assertValid();
      }
      active = true;
      try { await page.screencast.start({ onFrame, size: { width: 1600, height: 900 }, quality: 90 }); }
      catch { active = false; invalidate('TASK_CLOCK_START_FAILED'); }
      assertValid();
    },
    async ready(timeoutMs = 5000) {
      if (!active || stopped) { assertValid(); throw fail('TASK_CLOCK_INVALID_STATE'); }
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000) throw fail('TASK_CLOCK_INVALID_ARGUMENTS');
      const deadline = performance.now() + timeoutMs;
      while (!frames.length && !reason && performance.now() < deadline) await wait(10);
      if (!frames.length) invalidate('TASK_CLOCK_NO_FRAME');
      await Promise.all(writes); assertValid();
    },
    markTaskStart() {
      assertValid();
      if (!active || taskStart || !frames.length) throw fail('TASK_CLOCK_NOT_READY');
      const value = point();
      if (!frames.some(frame => frame.timestampMs <= value.wallTimeMs)) { invalidate('TASK_CLOCK_NO_INITIAL_FRAME'); assertValid(); }
      if (Math.abs(value.wallTimeMs - captureStarted.wallTimeMs - (value.monotonicMs - captureStarted.monotonicMs)) > 50) {
        invalidate('TASK_CLOCK_DRIFT'); assertValid();
      }
      taskStart = value; return { ...value };
    },
    markTaskEnd() {
      if (!active || !taskStart || taskEnd) throw fail('TASK_CLOCK_INVALID_STATE');
      taskEnd = point(); return { ...taskEnd };
    },
    async stop() {
      if (manifest) return manifest;
      if (stopped) throw fail('TASK_CLOCK_INVALID_STATE');
      stopped = true;
      if (active) {
        try { await page.screencast.stop(); } catch { invalidate('TASK_CLOCK_STOP_FAILED'); }
        active = false;
      }
      captureStopped = point();
      await Promise.all(writes);
      // Delivery can race between encoded frames. Keep every original and its arrival
      // index, but order playback by the browser's presentation clock, not IO arrival.
      frames.sort((a, b) => a.timestampMs - b.timestampMs || a.arrivalIndex - b.arrivalIndex);
      let timing = { durationMs: taskStart && taskEnd ? taskEnd.monotonicMs - taskStart.monotonicMs : null,
        clockDriftMs: null, coverage: { initialFrameAtOrBeforeStart: false, activeThroughTaskEnd: false } };
      if (!reason) {
        try { timing = validateTaskClock({ taskStart, taskEnd, captureStarted, captureStopped, frames }); }
        catch (error) { invalidate(error.code ?? 'TASK_CLOCK_INVALID_BOUNDS'); }
      }
      manifest = { schemaVersion: 1, status: reason ? 'invalid' : 'aligned', reason, width: 1600, height: 900,
        timestampBasis: 'browser-presentation-unix-epoch-ms', captureApi: 'page.screencast.start.onFrame',
        frameCadence: 'Event-driven browser frames; unchanged screens use sample-and-hold during playback.',
        maxClockDriftMs: 50, taskStart, taskEnd, captureStarted, captureStopped, ...timing, totalBytes, frames,
        delivery: { timestampRegressions, maxBackstepMs, maxAllowedBackstepMs: MAX_DELIVERY_BACKSTEP_MS,
          manifestOrder: 'Browser presentation timestamp, then original arrivalIndex; no frames discarded.' },
        ...(invalidFrame ? { invalidFrame } : {}) };
      try { await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); }
      catch { throw fail('TASK_CLOCK_WRITE_FAILED'); }
      return manifest;
    },
  };
}
