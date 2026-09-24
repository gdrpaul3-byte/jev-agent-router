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
