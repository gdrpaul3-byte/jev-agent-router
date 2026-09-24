#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source frames are samples, not native video: playback holds them at their measured times.
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const inside = (root, path) => {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const concatQuote = path => `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
const filterQuote = path => `'${path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''")}'`;
let stderrFile, child, logPath;
async function runFileTool(command, args) {
  const process = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', logging = Promise.resolve(), failed = false;
  process.once('error', () => { failed = true; });
  process.stdout.on('data', chunk => { if (stdout.length < 100_000) stdout += chunk; });
  process.stderr.on('data', chunk => { logging = logging.then(() => stderrFile.write(chunk)); });
  const code = await new Promise(done => process.once('close', done));
  await logging;
  if (failed || code !== 0) throw new Error('ENCODE_FAILED');
  return stdout;
}

try {
  const args = process.argv.slice(2), options = {};
  let trial;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--output', '--title', '--trial'].includes(arg)) {
      if (options[arg] !== undefined || args[index + 1] === undefined) throw new Error('INVALID_ARGUMENTS');
      options[arg] = args[++index];
    } else if (!arg.startsWith('--') && trial === undefined) trial = arg;
    else throw new Error('INVALID_ARGUMENTS');
  }
  if ((trial && options['--trial']) || !(trial ?? options['--trial']) || !options['--output']) throw new Error('INVALID_ARGUMENTS');
  trial = resolve(trial ?? options['--trial']);
  const output = resolve(options['--output']), title = options['--title'];
  if (!inside(workspace, trial) || !inside(workspace, output) || extname(output).toLowerCase() !== '.mp4') throw new Error('INVALID_PATH');
  if (title !== undefined && (!/^[\x20-\x7e]{1,160}$/.test(title) || !title.trim())) throw new Error('INVALID_TITLE');
  const manifestPath = resolve(trial, 'manifest.json');
  if ((await stat(manifestPath)).size > 2_000_000) throw new Error('INVALID_MANIFEST');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const durationMs = manifest.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(manifest.frames) || !manifest.frames.length) throw new Error('INVALID_MANIFEST');
  const samples = [];
  for (const frame of manifest.frames) {
    if (!frame || typeof frame.filename !== 'string' || basename(frame.filename) !== frame.filename
      || !/^frame-\d+\.png$/.test(frame.filename)
      || !Number.isFinite(frame.captureStartedMs) || !Number.isFinite(frame.capturedAtMs)
      || frame.captureStartedMs < 0 || frame.capturedAtMs < frame.captureStartedMs
      || frame.capturedAtMs > durationMs) throw new Error('INVALID_MANIFEST');
    const atMs = (frame.captureStartedMs + frame.capturedAtMs) / 2;
    if (samples.length && atMs <= samples.at(-1).atMs) throw new Error('INVALID_MANIFEST');
    const path = resolve(trial, frame.filename);
    if (!(await stat(path)).isFile()) throw new Error('MISSING_FRAME');
    samples.push({ path, atMs });
  }
  try { await access(output); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('OUTPUT_EXISTS'); }
  await mkdir(dirname(output), { recursive: true });
  const concatPath = `${output}.ffconcat`, renderPath = `${output}.render.json`;
  logPath = `${output}.encode.stderr.log`;
  stderrFile = await open(logPath, 'wx');
  // Concat can reset filters on size or pixel-format changes. Normalize copies first;
  // source screenshots can contain JPEG bytes despite their .png filenames.
  let width = 0, height = 0;
  for (const sample of samples) {
    const probe = JSON.parse(await runFileTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', sample.path]));
    const size = probe.streams?.[0];
    if (!Number.isSafeInteger(size?.width) || !Number.isSafeInteger(size?.height)
      || size.width <= 0 || size.height <= 0 || size.width > 16384 || size.height > 16384) throw new Error('INVALID_MANIFEST');
    width = Math.max(width, size.width); height = Math.max(height, size.height);
  }
  width += width % 2; height += height % 2;
  const normalizedDirectory = `${output}.frames`;
  await mkdir(normalizedDirectory);
  for (const [index, sample] of samples.entries()) {
    const normalizedPath = resolve(normalizedDirectory, `frame-${String(index).padStart(6, '0')}.png`);
    await runFileTool('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-n', '-i', sample.path,
      '-vf', `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24`,
      '-frames:v', '1', '-update', '1', normalizedPath]);
    sample.path = normalizedPath;
  }
  const lines = ['ffconcat version 1.0'];
  for (let index = 0; index < samples.length; index++) {
    const holdMs = (samples[index + 1]?.atMs ?? durationMs) - samples[index].atMs;
    lines.push(`file ${concatQuote(samples[index].path)}`, `duration ${(holdMs / 1000).toFixed(9)}`);
  }
  lines.push(`file ${concatQuote(samples.at(-1).path)}`); // Make the final duration effective.
  await writeFile(concatPath, `${lines.join('\n')}\n`, { flag: 'wx' });
  const filters = [`tpad=start_mode=add:start_duration=${(samples[0].atMs / 1000).toFixed(9)}:color=black`, 'pad=ceil(iw/2)*2:ceil(ih/2)*2'];
  if (title !== undefined) {
    const titlePath = `${output}.title.txt`, fontPath = 'C:/Windows/Fonts/arial.ttf';
    await access(fontPath);
    await writeFile(titlePath, title, { flag: 'wx' });
    filters.push(`drawtext=fontfile=${filterQuote(fontPath)}:textfile=${filterQuote(titlePath)}:expansion=none:fontcolor=white:fontsize=24:box=1:boxcolor=black@0.7:boxborderw=12:x=20:y=20`);
  }
  const info = { sourceManifest: manifestPath, output, sourceFrameCount: samples.length, durationMs,
    normalizedDirectory, width, height,
    outputFps: 15, initialBlackMs: samples[0].atMs,
    timingConvention: 'Capture midpoint. Black before first sample; hold samples until the next midpoint and the last until recording duration.',
    limitation: 'Timestamped screenshots, not native continuous video. Repeated output frames preserve elapsed time; motion between samples is unavailable.',
    ...(title === undefined ? {} : { title }), startedAtEpochMs: Date.now() };
  await writeFile(renderPath, JSON.stringify(info, null, 2), { flag: 'wx' });
  child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-n', '-f', 'concat', '-safe', '0',
    '-i', concatPath, '-vf', filters.join(','), '-t', (durationMs / 1000).toFixed(9), '-r', '15', '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let logging = Promise.resolve(), spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  child.stderr.on('data', chunk => { logging = logging.then(() => stderrFile.write(chunk)).catch(() => { child.kill(); }); });
  const code = await new Promise(done => child.once('close', done));
  await logging;
  Object.assign(info, { endedAtEpochMs: Date.now(), exitCode: code });
  await writeFile(renderPath, JSON.stringify(info, null, 2));
  if (spawnFailed || code !== 0) throw new Error('ENCODE_FAILED');
  process.stdout.write(`${JSON.stringify({ status: 'completed', output, frames: samples.length, durationMs, renderManifest: renderPath })}\n`);
} catch (error) {
  const allowed = ['INVALID_ARGUMENTS', 'INVALID_PATH', 'INVALID_TITLE', 'INVALID_MANIFEST', 'MISSING_FRAME', 'OUTPUT_EXISTS', 'ENCODE_FAILED'];
  process.stderr.write(`${JSON.stringify({ status: 'failed', reason: allowed.includes(error.message) ? error.message : 'RENDER_FAILED', ...(logPath ? { stderrFile: logPath } : {}) })}\n`);
  child?.kill(); process.exitCode = 1;
} finally { await stderrFile?.close().catch(() => {}); }
