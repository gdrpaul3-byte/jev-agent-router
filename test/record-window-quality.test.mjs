import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureQualityMonitor } from '../benchmarks/record-window.mjs';

const line = value => `[Parsed_metadata_1 @ 0x123] lavfi.signalstats.YAVG=${value}\n`;

test('visible content requires three nonblack samples and records luminance without claiming motion', () => {
  const monitor = createCaptureQualityMonitor(1000);
  monitor.feed(line(21), 1100); monitor.feed(line(80), 1200);
  assert.equal(monitor.summary().visibleFramesVerified, false);
  monitor.feed(line(130), 1300);
  assert.equal(monitor.summary().visibleFramesVerified, true);
  assert.equal(monitor.summary().samples, 3);
  assert.equal(monitor.summary().meanLuma, 77);
  assert.equal(monitor.summary().minLuma, 21); assert.equal(monitor.summary().maxLuma, 130);
  assert.equal(monitor.check(15000), null);
});

test('fragmented metadata lines count once and unrelated logs or invalid values cannot create readiness', () => {
  const monitor = createCaptureQualityMonitor(0);
  monitor.feed('[Parsed_metadata_1 @ x] lavfi.signal', 10);
  monitor.feed('stats.YAVG=25.125\r\nframe=99\n', 20);
  monitor.feed('lavfi.signalstats.YAVG=NaN\nlavfi.signalstats.YAVG=256\nlavfi.signalstats.YAVG=-1\n', 30);
  assert.equal(monitor.summary().samples, 1); assert.equal(monitor.summary().invalidSamples, 3);
  assert.equal(monitor.summary().meanLuma, 25.125);
  assert.equal(monitor.summary().visibleFramesVerified, false);
});

test('black frames fail after two seconds and failure remains sticky even after later visible samples', () => {
  const monitor = createCaptureQualityMonitor(0);
  assert.equal(monitor.feed(line(16), 100), null);
  assert.equal(monitor.feed(line(20), 1000), null);
  assert.equal(monitor.check(2099), null);
  assert.equal(monitor.check(2100), 'BLACK_CAPTURE');
  monitor.feed(line(100) + line(100) + line(100), 2200);
  assert.equal(monitor.check(2200), 'BLACK_CAPTURE');
  assert.equal(monitor.summary().blackSamples, 2);
});

test('visible frames reset a short black interval; darkness after readiness is still detected', () => {
  const monitor = createCaptureQualityMonitor(0);
  monitor.feed(line(16), 100); monitor.feed(line(80), 1000);
  monitor.feed(line(16), 1100); monitor.feed(line(80), 2000); monitor.feed(line(80), 2100);
  assert.equal(monitor.check(3000), null); assert.equal(monitor.summary().visibleFramesVerified, true);
  monitor.feed(line(16), 3100);
  assert.equal(monitor.check(5100), 'BLACK_CAPTURE');
});

test('no statistics, insufficient visible frames and malformed metadata fail at the startup deadline', () => {
  for (const samples of ['', line(80), line(80) + line(90), 'lavfi.signalstats.YAVG=not-a-number\n']) {
    const monitor = createCaptureQualityMonitor(1000);
    monitor.feed(samples, 2000);
    assert.equal(monitor.check(10999), null);
    assert.equal(monitor.check(11000), 'NO_VISIBLE_CAPTURE');
  }
});

test('limited-range black at 16 and full-range black at 0 never pass readiness', () => {
  for (const luma of [0, 16, 20]) {
    const monitor = createCaptureQualityMonitor(0);
    monitor.feed(line(luma), 0); monitor.feed(line(luma), 1000); monitor.feed(line(luma), 2000);
    assert.equal(monitor.summary().visibleFramesVerified, false);
    assert.equal(monitor.summary().errorCode, 'BLACK_CAPTURE');
  }
});
