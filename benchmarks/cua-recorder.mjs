import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Captures injected screenshot bytes serially; it has no UI or recording API access. */
export function startRecorder({ capture, directory, intervalMs = 250, maxDurationMs = 45000 } = {}) {
  if (typeof capture !== 'function' || typeof directory !== 'string' || !directory.trim()
    || !Number.isFinite(intervalMs) || intervalMs <= 0
    || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error('INVALID_RECORDER_OPTIONS');
  const started = performance.now();
  const elapsed = () => Math.max(0, performance.now() - started);
  const metadata = { format: 'timestamped-screenshot-recording', intervalMs, maxDurationMs, startedAtMs: started,
    startedAt: new Date().toISOString(), frames: [], errors: [] };
  let stopping = false, stopped = false, failed = false, finalRequested = false;
  let wake, stopDeadline = Infinity, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const recordError = code => { metadata.errors.push({ code, atMs: elapsed() }); failed = true; };

  async function takeFrame() {
    const captureStartedMs = elapsed();
    const remaining = Math.min(5000, maxDurationMs - captureStartedMs, stopDeadline - captureStartedMs);
    if (remaining <= 0) return false;
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(capture).then(bytes => ({ bytes, capturedAtMs: elapsed() }), () => ({ error: 'CAPTURE_FAILED' })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'CAPTURE_TIMEOUT' }), remaining); }),
      ]);
      if (result.error) { recordError(result.error); return false; }
      if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0) {
        recordError('INVALID_FRAME'); return false;
      }
      const filename = `frame-${String(metadata.frames.length).padStart(6, '0')}.png`;
      await writeFile(join(directory, filename), result.bytes);
      metadata.frames.push({ filename, captureStartedMs, capturedAtMs: result.capturedAtMs });
      return true;
    } catch { recordError('FRAME_WRITE_FAILED'); return false; }
    finally { clearTimeout(timer); }
  }

  async function waitForNextFrame() {
    const lastStarted = metadata.frames.at(-1)?.captureStartedMs ?? elapsed();
    const delay = Math.max(0, Math.min(lastStarted + intervalMs - elapsed(), maxDurationMs - elapsed()));
    if (!delay) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, delay);
      wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    });
  }

  const completed = (async () => {
    try { await mkdir(directory, { recursive: true }); }
    catch { recordError('DIRECTORY_WRITE_FAILED'); }
    if (!failed && await takeFrame()) resolveReady(metadata);
    else rejectReady(new Error('RECORDER_NOT_READY'));
    while (!failed && !stopping && elapsed() < maxDurationMs) {
      await waitForNextFrame();
      if (stopping || elapsed() >= maxDurationMs) break;
      if (!await takeFrame()) break;
    }
    if (finalRequested && !failed) await takeFrame();
    metadata.durationMs = elapsed();
    metadata.firstFrameAtMs = metadata.frames[0]?.capturedAtMs ?? null;
    metadata.lastFrameAtMs = metadata.frames.at(-1)?.capturedAtMs ?? null;
    metadata.stopReason = failed ? 'ERROR' : stopping ? 'REQUESTED' : 'MAX_DURATION';
    stopped = true;
    try { await writeFile(join(directory, 'manifest.json'), JSON.stringify(metadata, null, 2)); }
    catch { recordError('MANIFEST_WRITE_FAILED'); metadata.stopReason = 'ERROR'; }
    return metadata;
  })();

  return { ready, metadata, stop({ captureFinal = true } = {}) {
    if (typeof captureFinal !== 'boolean') throw new Error('INVALID_RECORDER_OPTIONS');
    if (!stopping && !stopped) {
      stopping = true;
      finalRequested = captureFinal;
      metadata.stopRequestedAtMs = elapsed();
      stopDeadline = metadata.stopRequestedAtMs + 5000;
      wake?.();
    }
    return completed;
  } };
}
