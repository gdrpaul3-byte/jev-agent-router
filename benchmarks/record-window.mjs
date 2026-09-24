#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
let logFile, metadataFile, child, logPath, metadataPath;
let wallLimit, hardStop, onInput;
let logQueue = Promise.resolve(), ready = false, stopRequested = false;
const metadata = { fps: 15 };
const reportFailure = code => process.stderr.write(`FAILED ${code}${logPath ? ` ${JSON.stringify({ stderrFile: logPath })}` : ''}\n`);

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--title', '--desktop-rect', '--output', '--max-seconds'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  const title = options['--title'], rectangle = options['--desktop-rect'];
  const maxSecondsInput = options['--max-seconds'] ?? '180';
  const maxSeconds = Number(maxSecondsInput);
  if (!/^\d+$/.test(maxSecondsInput) || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 1800) throw new Error('INVALID_ARGUMENTS');
  metadata.maxDurationSeconds = maxSeconds;
  if ((title !== undefined) === (rectangle !== undefined) || !options['--output']) throw new Error('INVALID_ARGUMENTS');
  if (title !== undefined && (!title.trim() || /[\r\n\0]/.test(title))) throw new Error('INVALID_ARGUMENTS');
  let desktopRect;
  if (rectangle !== undefined) {
    const pieces = rectangle.split(',').map(value => value.trim());
    if (pieces.length !== 4 || pieces.some(value => !/^-?\d+$/.test(value))) throw new Error('INVALID_ARGUMENTS');
    const [x, y, width, height] = pieces.map(Number);
    if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0) throw new Error('INVALID_ARGUMENTS');
    desktopRect = { x, y, width, height };
  }
  const output = resolve(options['--output']), inside = relative(workspace, output);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || extname(output).toLowerCase() !== '.mp4') throw new Error('INVALID_OUTPUT_PATH');
  try { await access(output); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('OUTPUT_EXISTS'); }
  await mkdir(dirname(output), { recursive: true });
  logPath = resolve(dirname(output), 'stderr.log');
  metadataPath = resolve(dirname(output), 'recording.json');
  metadataFile = await open(metadataPath, 'wx');
  logFile = await open(logPath, 'wx');
  Object.assign(metadata, { targetTitle: title ?? null, ...(desktopRect ? { desktopRect } : {}),
    output, processStartedAtEpochMs: Date.now(), inputStartEpochSeconds: null });
  const saveMetadata = async () => {
    const text = JSON.stringify(metadata, null, 2);
    await metadataFile.truncate(0);
    await metadataFile.write(text, 0, 'utf8');
  };
  await saveMetadata();
  metadata.processStartedAtEpochMs = Date.now();
  const input = desktopRect
    ? ['-offset_x', String(desktopRect.x), '-offset_y', String(desktopRect.y), '-video_size', `${desktopRect.width}x${desktopRect.height}`, '-i', 'desktop']
    : ['-i', `title=${title}`];
  child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-n', '-f', 'gdigrab',
    '-framerate', '15', '-draw_mouse', '1', ...input, '-t', String(maxSeconds),
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-nostats', '-stats_period', '0.25', '-progress', 'pipe:2', output],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let tail = '', firstFrame = false, spawnFailed = false;
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    metadata.stopRequestedAtEpochMs = Date.now();
    if (child.stdin.writable) child.stdin.write('q');
    hardStop = setTimeout(() => child.kill(), 5000);
  };
  onInput = data => { if (data.toString().includes('q')) requestStop(); };
  process.stdin.on('data', onInput);
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  child.stdin.on('error', () => {});
  child.once('error', () => { spawnFailed = true; });
  child.stderr.on('data', chunk => {
    tail = (tail + chunk.toString()).slice(-16000);
    const start = /Input #\d+, gdigrab,[\s\S]*?start:\s*(-?\d+(?:\.\d+)?)/.exec(tail);
    if (start) metadata.inputStartEpochSeconds = Number(start[1]);
    if (/(?:^|[\r\n])frame=\s*[1-9]\d*/.test(tail)) firstFrame = true;
    logQueue = logQueue.then(async () => {
      await logFile.write(chunk);
      if (!ready && firstFrame && Number.isFinite(metadata.inputStartEpochSeconds) && metadata.inputStartEpochSeconds > 0) {
        metadata.readyAtEpochMs = Date.now();
        await saveMetadata();
        ready = true;
        process.stdout.write(`READY ${JSON.stringify({ output, metadataFile: metadataPath })}\n`);
      }
    }).catch(() => { metadata.errorCode = 'LOG_WRITE_FAILED'; requestStop(); });
  });
  wallLimit = setTimeout(requestStop, maxSeconds * 1000);
  const result = await new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })));
  clearTimeout(wallLimit); clearTimeout(hardStop);
  process.stdin.removeListener('data', onInput); process.stdin.pause();
  await logQueue;
  Object.assign(metadata, { processEndedAtEpochMs: Date.now(), exitCode: result.code, signal: result.signal });
  if (spawnFailed || result.code !== 0 || !ready) metadata.errorCode ??= spawnFailed ? 'ENCODER_START_FAILED' : 'CAPTURE_FAILED';
  await saveMetadata();
  if (metadata.errorCode) { reportFailure(metadata.errorCode); process.exitCode = 1; }
  else process.stdout.write(`STOPPED ${JSON.stringify({ metadataFile: metadataPath })}\n`);
} catch (error) {
  const allowed = ['INVALID_ARGUMENTS', 'INVALID_OUTPUT_PATH', 'OUTPUT_EXISTS'];
  reportFailure(allowed.includes(error.message) ? error.message : 'RECORDER_FAILED');
  child?.kill(); process.exitCode = 1;
} finally {
  clearTimeout(wallLimit); clearTimeout(hardStop);
  if (onInput) process.stdin.removeListener('data', onInput);
  process.stdin.pause();
  await logFile?.close().catch(() => {});
  await metadataFile?.close().catch(() => {});
}
