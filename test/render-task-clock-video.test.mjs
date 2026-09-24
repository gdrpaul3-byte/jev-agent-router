import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFramePlan } from '../benchmarks/render-task-clock-video.mjs';
const fixture = () => ({ schemaVersion: 1, status: 'aligned', width: 1600, height: 900,
  timestampBasis: 'browser-presentation-unix-epoch-ms', taskStart: { wallTimeMs: 1000, monotonicMs: 100 },
  taskEnd: { wallTimeMs: 1125, monotonicMs: 225 }, durationMs: 125, clockDriftMs: 0,
  captureStarted: { wallTimeMs: 850, monotonicMs: 0 }, captureStopped: { wallTimeMs: 1250, monotonicMs: 400 },
  coverage: { initialFrameAtOrBeforeStart: true, activeThroughTaskEnd: true },
  frames: [900, 1030, 1100, 1200].map((timestampMs, i) => ({ file: `frames/${String(i + 1).padStart(6, '0')}.jpg`, timestampMs, sha256: 'a'.repeat(64), bytes: 10 })) });
const report = { status: 'completed', timing: { taskDurationMs: 125 } };
test('task clock begins before inference and samples browser presentation times without deleting idle time', () => {
  const plan = taskFramePlan(fixture(), report);
  assert.deepEqual(plan.indices, [0, 1, 1, 2]);
  assert.equal(plan.measuredTaskSeconds, 0.125); assert.equal(plan.frameCount, 4); assert.equal(plan.tailRoundingMs, 35);
});
test('task alignment rejects missing clock evidence, mismatched duration, non-monotonic frames and escaping paths', () => {
  for (const mutate of [m => m.status = 'invalid', m => m.clockDriftMs = 51, m => m.durationMs = 126,
    m => m.coverage.activeThroughTaskEnd = false, m => m.frames[0].timestampMs = 1001,
    m => m.frames[2].timestampMs = 800, m => m.frames[0].file = '../secret.jpg', m => m.taskEnd.monotonicMs = undefined,
    m => m.taskEnd.wallTimeMs = 9999999, m => delete m.captureStopped, m => m.frames[0].bytes = -1]) {
    const value = fixture(); mutate(value); assert.throws(() => taskFramePlan(value, report));
  }
});
