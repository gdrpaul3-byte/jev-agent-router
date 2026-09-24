import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonTimeline } from '../benchmarks/render-browser-comparison.mjs';
function fixture() {
  return ['astra', 'jev'].map((arm, index) => ({
    report: { arm, status: 'completed', protocol: { comparisonHash: 'a'.repeat(64) },
      result: { passed: true, cost: { complete: true, accountedProviderUsd: index ? 0.01801461 : 0.1424 } },
      timing: { taskDurationMs: index ? 12711.0779 : 26690.936 } },
    media: { validPixels: true, width: 1600, height: 900, frames: index ? 487 : 799,
      durationSeconds: index ? 19.48 : 31.96, mp4Sha256: 'b'.repeat(64) },
  }));
}
test('replay clocks use source durations, never measured task times or estimated offsets', () => {
  const plan = comparisonTimeline(fixture());
  assert.equal(plan.totalSeconds, 33.96);
  assert.deepEqual(plan.panels.map(panel => panel.clipSeconds), [31.96, 19.48]);
  assert.deepEqual(plan.panels.map(panel => Number(panel.heldSeconds.toFixed(2))), [2, 14.48]);
  assert.deepEqual(plan.panels.map(panel => panel.measuredTaskSeconds), [26.690936, 12.7110779]);
  assert.deepEqual(plan.panels.map(panel => panel.jevUsed), [false, true]);
  assert.equal(plan.speed, 1); assert.equal(plan.cuts, false);
});
test('refuses mismatched protocols, failed results, wrong arms and invalid media timelines', () => {
  for (const change of [
    value => { value[1].report.protocol.comparisonHash = 'c'.repeat(64); },
    value => { value[0].report.result.passed = false; },
    value => { value[0].report.arm = 'jev'; },
    value => { value[1].media.durationSeconds = 12.71; },
    value => { value[1].media.validPixels = false; },
  ]) { const input = fixture(); change(input); assert.throws(() => comparisonTimeline(input)); }
});

test('task clocks require verified timestamp-based clips and stop at measured completion', () => {
  const inputs = fixture();
  for (const input of inputs) {
    input.report.taskClock = { status: 'aligned', sha256: 'c'.repeat(64) };
    input.media.frames = Math.ceil(input.report.timing.taskDurationMs / 40);
    input.media.durationSeconds = input.media.frames / 25;
    input.media.taskAlignment = { kind: 'browser-task-clock', sourceManifestSha256: 'c'.repeat(64), measuredTaskSeconds: input.report.timing.taskDurationMs / 1000 };
  }
  const plan = comparisonTimeline(inputs);
  assert.equal(plan.taskAligned, true);
  assert.deepEqual(plan.panels.map(panel => panel.clockEndSeconds), [26.690936, 12.7110779]);
  assert.match(plan.alignment, /before initial model inference/);
  inputs[0].media.taskAlignment.sourceManifestSha256 = 'd'.repeat(64);
  assert.throws(() => comparisonTimeline(inputs), /INVALID_TASK_ALIGNMENT/);
  delete inputs[0].media.taskAlignment;
  assert.throws(() => comparisonTimeline(inputs), /MIXED_CLOCKS/);
});
