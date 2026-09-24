#!/usr/bin/env node
// Decode real browser footage. No browser actions, generated frames, cuts, or speed changes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || process.argv.length !== 4) throw new Error('EXPECTED_SOURCE_AND_NEW_OUTPUT_DIRECTORY');
const source = resolve(sourceArgument), output = resolve(outputArgument);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // New outputs only; never replace a previous inspection.
async function run(command, args) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', tooLarge = false;
    const timer = setTimeout(() => child.kill(), 180000);
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
      if (stdout.length + stderr.length > 4000000) { tooLarge = true; child.kill(); return; }
      if (key === 'out') stdout += chunk; else stderr += chunk;
    });
    child.once('error', () => { clearTimeout(timer); fail(new Error('MEDIA_TOOL_START_FAILED')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) fail(new Error('MEDIA_DECODE_FAILED'));
      else ok({ stdout, stderr });
    });
  });
}
const common = ['-hide_banner', '-nostdin', '-n', '-protocol_whitelist', 'file', '-i', source];
const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=width,height,codec_name,nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', source])).stdout);
const stream = probe.streams?.[0], durationSeconds = Number(probe.format?.duration), frames = Number(stream?.nb_read_frames);
if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(frames) || frames < 3) throw new Error('INVALID_VIDEO');
const quality = await run('ffmpeg', [...common, '-vf', 'blackdetect=d=0.2:pix_th=0.05:pic_th=0.98,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']);
const luminance = Array.from(quality.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g), match => Number(match[1]));
const blackIntervals = Array.from(quality.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g), m => ({ start: +m[1], end: +m[2], duration: +m[3] }));
if (luminance.length !== frames) throw new Error('INCOMPLETE_DECODE');
const nonBlackFrames = luminance.filter(value => value > 20).length;
const indices = [...new Set([0.05, 0.25, 0.5, 0.75, 0.98].map(fraction => Math.floor((frames - 1) * fraction)))];
const select = indices.map(index => `eq(n,${index})`).join('+');
await run('ffmpeg', [...common, '-vf', `select='${select}',scale=640:-2,tile=${indices.length}x1`, '-frames:v', '1', '-update', '1', join(output, 'contact-sheet.png')]);
const posterFrameIndex = indices[Math.floor(indices.length / 2)];
await run('ffmpeg', [...common, '-vf', `select='eq(n,${posterFrameIndex})'`, '-frames:v', '1', '-update', '1', join(output, 'poster.png')]);
const hashes = (await run('ffmpeg', [...common, '-vf', `select='${select}'`, '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])).stdout;
const sampleHashes = hashes.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
const distinctSampleFrames = new Set(sampleHashes).size;
const validPixels = nonBlackFrames >= 3 && nonBlackFrames / frames >= 0.95 && distinctSampleFrames > 1;
const result = { schemaVersion: 1, sourceFile: basename(source), sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  width: stream.width, height: stream.height, frames, durationSeconds, blackIntervals, nonBlackFrames,
  meanLuma: luminance.reduce((a,b) => a+b, 0) / luminance.length, minLuma: Math.min(...luminance), maxLuma: Math.max(...luminance),
  sampleFrameIndices: indices, posterFrameIndex, distinctSampleFrames, validPixels, visualReviewRequired: true,
  limitation: 'Decoded pixels and sample differences do not prove task success or privacy; inspect the contact sheet and task report.',
  encoding: { cuts: false, speed: 1, padding: false, audio: false, crop: false } };
if (validPixels) {
  await run('ffmpeg', [...common, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-movflags', '+faststart', join(output, 'video.mp4')]);
  result.mp4Sha256 = createHash('sha256').update(await readFile(join(output, 'video.mp4'))).digest('hex');
}
await writeFile(join(output, 'media.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
if (!validPixels) process.exitCode = 2;
