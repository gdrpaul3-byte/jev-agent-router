import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { clockPoint, createTaskClockCapture, validateTaskClock } from '../benchmarks/task-clock-capture.mjs';

const epoch = 1800000000000;
const point = n => ({ wallTimeMs: epoch + n, monotonicMs: n });
const frame = timestamp => ({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), timestamp, viewportWidth: 1600, viewportHeight: 900 });
const timeline = () => ({ captureStarted: point(0), taskStart: point(100), taskEnd: point(1100), captureStopped: point(1150),
  frames: [{ timestampMs: epoch + 90 }, { timestampMs: epoch + 500 }] });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-clock-test-'));
  t.after(async () => { const absolute = resolve(root); assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return root;
}
function fixture() {
  let tick = 0, onFrame = null, running = false;
  const events = [];
  return { events, now: () => tick, wallNow: () => epoch + tick, set: value => { tick = value; },
    send: value => onFrame(value),
    page: { screencast: {
      async start(options) { assert.deepEqual(options.size, { width: 1600, height: 900 }); assert.equal(options.quality, 90);
        running = true; onFrame = options.onFrame; events.push('start'); await onFrame(frame(epoch)); },
      async stop() { assert.equal(running, true); events.push('stop'); running = false; },
    } } };
}

test('task clock anchors and browser frames share wall time while preserving monotonic duration', () => {
  assert.deepEqual(clockPoint(() => 50, () => epoch + 50), point(50));
  const result = validateTaskClock(timeline());
  assert.equal(result.durationMs, 1000); assert.equal(result.clockDriftMs, 0);
  assert.equal(result.coverage.activeThroughTaskEnd, true);
  // An unchanged screen need not emit a frame at task completion.
  const still = timeline(); still.frames = [{ timestampMs: epoch }];
  assert.equal(validateTaskClock(still).coverage.initialFrameAtOrBeforeStart, true);
});

test('missing start frame, reversed timestamps, invalid bounds and wall-clock drift fail alignment', () => {
  const missing = timeline(); missing.frames = [{ timestampMs: epoch + 101 }];
  assert.throws(() => validateTaskClock(missing), /TASK_CLOCK_FRAME_TIMELINE/);
  const reversed = timeline(); reversed.frames.reverse();
  assert.throws(() => validateTaskClock(reversed), /TASK_CLOCK_FRAME_TIMELINE/);
  const bounds = timeline(); bounds.captureStopped = point(1000);
  assert.throws(() => validateTaskClock(bounds), /TASK_CLOCK_INVALID_BOUNDS/);
  const drift = timeline(); drift.taskEnd.wallTimeMs += 51;
  assert.throws(() => validateTaskClock(drift), /TASK_CLOCK_DRIFT/);
  const setupDrift = timeline(); setupDrift.taskStart.wallTimeMs += 51; setupDrift.taskEnd.wallTimeMs += 51;
  assert.throws(() => validateTaskClock(setupDrift), /TASK_CLOCK_DRIFT/);
  const boundary = timeline(); boundary.taskEnd.wallTimeMs += 50;
  assert.equal(validateTaskClock(boundary).clockDriftMs, 50);
  assert.throws(() => validateTaskClock({ ...timeline(), taskStart: null }), /TASK_CLOCK_MISSING_BOUNDS/);
});

test('capture saves bounded JPEG source frames with hashes and relative paths; stop flushes pending writes', async t => {
  const root = await temporary(t), f = fixture();
  const capture = createTaskClockCapture(f.page, root, { now: f.now, wallNow: f.wallNow });
  await capture.start(); await capture.ready();
  f.set(100); assert.deepEqual(capture.markTaskStart(), point(100));
  f.set(300); void f.send(frame(epoch + 250));
  f.set(900); assert.deepEqual(capture.markTaskEnd(), point(900));
  f.set(950); const manifest = await capture.stop();
  assert.equal(manifest.status, 'aligned'); assert.equal(manifest.durationMs, 800); assert.equal(manifest.frames.length, 2);
  assert.deepEqual(f.events, ['start', 'stop']);
  assert.equal(manifest.frames[1].file, 'frames/000002.jpg');
  const bytes = await readFile(join(root, manifest.frames[1].file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.frames[1].sha256);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), manifest);
  assert.ok(!JSON.stringify(manifest).includes(root));
  assert.equal(await capture.stop(), manifest);
});

test('unsupported capture and absent ready frame fail before any task starts', async t => {
  const root = await temporary(t);
  const unsupported = createTaskClockCapture({}, join(root, 'unsupported'));
  await assert.rejects(unsupported.start(), /TASK_CLOCK_UNSUPPORTED/);
  assert.equal((await unsupported.stop()).status, 'invalid');
  const silent = createTaskClockCapture({ screencast: { async start() {}, async stop() {} } }, join(root, 'silent'));
  await silent.start(); await assert.rejects(silent.ready(0), /TASK_CLOCK_NO_FRAME/);
  assert.throws(() => silent.markTaskStart(), /TASK_CLOCK_NO_FRAME/);
  assert.equal((await silent.stop()).reason, 'TASK_CLOCK_NO_FRAME');
});

test('out-of-delivery-order frames retain originals and sort stably by actual browser timestamps', async t => {
  const root = await temporary(t), f = fixture();
  const capture = createTaskClockCapture(f.page, root, { now: f.now, wallNow: f.wallNow });
  await capture.start(); await capture.ready(); f.set(100); capture.markTaskStart();
  f.set(500);
  f.send(frame(epoch + 400)); f.send(frame(epoch + 390)); f.send(frame(epoch + 400));
  f.set(1000); capture.markTaskEnd(); const manifest = await capture.stop();
  assert.equal(manifest.status, 'aligned'); assert.equal(manifest.frames.length, 4);
  assert.deepEqual(manifest.frames.map(item => item.arrivalIndex), [1, 3, 2, 4]);
  assert.deepEqual(manifest.frames.map(item => item.file), ['frames/000001.jpg', 'frames/000003.jpg', 'frames/000002.jpg', 'frames/000004.jpg']);
  assert.equal(manifest.delivery.timestampRegressions, 1); assert.equal(manifest.delivery.maxBackstepMs, 10);
  for (const item of manifest.frames) assert.equal((await readFile(join(root, item.file))).length, item.bytes);
});

test('presentation backsteps over one second remain invalid clock evidence', async t => {
  const root = await temporary(t), f = fixture();
  const capture = createTaskClockCapture(f.page, root, { now: f.now, wallNow: f.wallNow });
  await capture.start(); await capture.ready(); f.set(100); capture.markTaskStart();
  f.set(2000); f.send(frame(epoch + 2000)); f.send(frame(epoch + 999));
  f.set(2100); capture.markTaskEnd(); const manifest = await capture.stop();
  assert.equal(manifest.status, 'invalid'); assert.deepEqual(manifest.invalidFrame.issues, ['timestamp-regression-exceeds-limit']);
});

test('frame limit, future timestamps, bad viewport and failed shutdown can never certify alignment', async t => {
  const root = await temporary(t);
  for (const scenario of ['limit', 'future', 'viewport', 'shutdown']) {
    const f = fixture();
    const capture = createTaskClockCapture(f.page, join(root, scenario), { now: f.now, wallNow: f.wallNow,
      ...(scenario === 'limit' ? { limits: { maxFrames: 1 } } : {}) });
    await capture.start(); await capture.ready(); f.set(10); capture.markTaskStart();
    f.set(100);
    if (scenario === 'limit') await f.send(frame(epoch + 100));
    if (scenario === 'future') await f.send(frame(epoch + 151));
    if (scenario === 'viewport') await f.send({ ...frame(epoch + 100), viewportWidth: 100 });
    if (scenario === 'shutdown') f.page.screencast.stop = async () => { throw new Error('untrusted detail'); };
    f.set(200); capture.markTaskEnd();
    const manifest = await capture.stop();
    assert.equal(manifest.status, 'invalid'); assert.ok(!JSON.stringify(manifest).includes('untrusted'));
    assert.equal(manifest.coverage.activeThroughTaskEnd, false);
    if (scenario === 'future') {
      assert.deepEqual(manifest.invalidFrame.issues, ['future-timestamp']);
      assert.equal(manifest.invalidFrame.timestampMinusReceiveMs, 51);
    }
    if (scenario === 'viewport') assert.deepEqual(manifest.invalidFrame.issues, ['viewport-mismatch']);
  }
});
