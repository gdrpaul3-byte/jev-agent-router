#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// File-only rendering. Source epochs are supplied explicitly; no browser or capture APIs.
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const requiredFlags = ['--direct', '--direct-start-epoch-ms', '--direct-end-epoch-ms', '--jev', '--jev-start-epoch-ms', '--jev-end-epoch-ms', '--output'];
const flags = [...requiredFlags, '--jev-note', '--jev-note-from-seconds', '--direct-note', '--direct-note-from-seconds'];
const inside = path => { const rel = relative(workspace, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const quote = value => `'${value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''")}'`;
let log, metadataPath, metadata, metadataCreated = false;
async function run(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', failed = false;
  child.once('error', () => { failed = true; });
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2_000_000); });
  const code = await new Promise(done => child.once('close', done));
  if (log) await log.write(`${command}\n${stderr}\n`);
  if (failed || code !== 0) throw new Error('MEDIA_TOOL_FAILED');
  return { stdout, stderr };
}
async function probe(path) {
  return JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,duration,nb_frames', '-of', 'json', path])).stdout).streams?.[0];
}

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || options[args[i]] !== undefined || !args[i + 1]) throw new Error('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  if (requiredFlags.some(flag => options[flag] === undefined)) throw new Error('INVALID_ARGUMENTS');
  const jevNote = options['--jev-note'];
  const noteFromRaw = options['--jev-note-from-seconds'] ?? '0', noteFromSeconds = Number(noteFromRaw);
  if ((jevNote !== undefined && (!/^[\x20-\x7e]{1,160}$/.test(jevNote) || !jevNote.trim()))
    || (!jevNote && options['--jev-note-from-seconds'] !== undefined)
    || !/^\d+(?:\.\d+)?$/.test(noteFromRaw) || !Number.isFinite(noteFromSeconds) || noteFromSeconds > 1800) throw new Error('INVALID_ARGUMENTS');
  const directNote = options['--direct-note'];
  const directNoteFromRaw = options['--direct-note-from-seconds'] ?? '0', directNoteFromSeconds = Number(directNoteFromRaw);
  if ((directNote !== undefined && (!/^[\x20-\x7e]{1,160}$/.test(directNote) || !directNote.trim()))
    || (!directNote && options['--direct-note-from-seconds'] !== undefined)
    || !/^\d+(?:\.\d+)?$/.test(directNoteFromRaw) || !Number.isFinite(directNoteFromSeconds) || directNoteFromSeconds > 1800) throw new Error('INVALID_ARGUMENTS');
  const output = resolve(options['--output']);
  if (!inside(output) || extname(output).toLowerCase() !== '.mp4') throw new Error('INVALID_PATH');
  try { await access(output); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('OUTPUT_EXISTS'); }
  const trials = [];
  for (const mode of ['direct', 'jev']) {
    const source = resolve(options[`--${mode}`]);
    if (!inside(source) || extname(source).toLowerCase() !== '.mp4') throw new Error('INVALID_PATH');
    const epoch = ['start', 'end'].map(kind => {
      const raw = options[`--${mode}-${kind}-epoch-ms`], value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_ARGUMENTS');
      return value;
    });
    if (epoch[1] <= epoch[0] || epoch[1] - epoch[0] > 1_800_000) throw new Error('INVALID_ARGUMENTS');
    const recordingPath = resolve(dirname(source), 'recording.json');
    const recording = JSON.parse(await readFile(recordingPath, 'utf8'));
    if (recording.exitCode !== 0 || !Number.isFinite(recording.inputStartEpochSeconds)) throw new Error('INVALID_RECORDING');
    const start = (epoch[0] - recording.inputStartEpochSeconds * 1000) / 1000;
    const duration = (epoch[1] - epoch[0]) / 1000, sourceInfo = await probe(source);
    if (!Number.isSafeInteger(sourceInfo?.width) || !Number.isSafeInteger(sourceInfo?.height)
      || sourceInfo.width < 2 || sourceInfo.height < 2 || sourceInfo.width > 8192 || sourceInfo.height > 8192 || !Number.isFinite(Number(sourceInfo.duration))
      || start < 0 || start + duration + 3 > Number(sourceInfo.duration) + 1 / 15) throw new Error('INVALID_RECORDING');
    trials.push({ mode, source, recordingPath, startEpochMs: epoch[0], endEpochMs: epoch[1], startSeconds: start,
      durationSeconds: duration, sourceDurationSeconds: Number(sourceInfo.duration), sourceWidth: sourceInfo.width, sourceHeight: sourceInfo.height });
  }
  await mkdir(dirname(output), { recursive: true });
  log = await open(`${output}.stderr.log`, 'wx');
  const total = Math.max(...trials.map(trial => trial.durationSeconds)) + 3;
  const panelWidth = Math.ceil(Math.min(960, Math.max(...trials.map(trial => trial.sourceWidth))) / 2) * 2;
  for (const trial of trials) trial.scaledHeight = Math.round(trial.sourceHeight * panelWidth / trial.sourceWidth / 2) * 2;
  const panelHeight = Math.max(...trials.map(trial => trial.scaledHeight)), headerHeight = jevNote || directNote ? 160 : 126;
  const canvasHeight = panelHeight + headerHeight;
  metadataPath = `${output}.render.json`;
  metadata = { output, playbackSpeed: 1, fps: 15, tailSeconds: 3, panelWidth, panelHeight, source: 'Actual native Chrome window recording', trials,
    ...(jevNote ? { jevNote, jevNoteFromSeconds: noteFromSeconds, jevUsedHostRecovery: true } : {}),
    ...(directNote ? { directNote, directNoteFromSeconds, directRestarted: true } : {}),
    convention: 'Epoch-aligned measured interval at 1x, then 3 seconds of actual post-verification recording. Shorter panel freezes only after its tail. Elapsed timer stops at measured completion.',
    status: 'rendering', startedAtEpochMs: Date.now() };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { flag: 'wx' });
  metadataCreated = true;
  const filters = [], inputArgs = [], font = quote('C:/Windows/Fonts/arial.ttf');
  for (const [index, trial] of trials.entries()) {
    const d = trial.durationSeconds, label = index === 0 ? (directNote ? 'Ordinary Codex (restart)' : 'Ordinary Codex') : (jevNote ? 'JEV assisted (host recovery)' : 'JEV assisted');
    const note = index === 0 ? directNote : jevNote, noteAt = index === 0 ? directNoteFromSeconds : noteFromSeconds;
    const notePath = `${output}.${trial.mode}-note.txt`;
    if (note) await writeFile(notePath, note, { flag: 'wx' });
    const timerPath = `${output}.${trial.mode}-timer.txt`;
    await writeFile(timerPath, `Elapsed %{pts:hms} / ${d.toFixed(3)} s`, { flag: 'wx' });
    inputArgs.push('-ss', trial.startSeconds.toFixed(6), '-t', (d + 3).toFixed(6), '-i', trial.source);
    filters.push(`[${index}:v]setpts=PTS-STARTPTS,scale=${panelWidth}:${trial.scaledHeight},pad=${panelWidth}:${panelHeight}:0:(oh-ih)/2:color=black,setsar=1,tpad=stop_mode=clone:stop_duration=${(total - d - 3 + 0.2).toFixed(6)},pad=${panelWidth}:${canvasHeight}:0:${headerHeight}:color=0x111827,` +
      `drawtext=fontfile=${font}:text='${label} - ${d.toFixed(3)} seconds':fontcolor=white:fontsize=27:x=14:y=12,` +
      `drawtext=fontfile=${font}:text='Actual Chrome window recording | 1x':fontcolor=white:fontsize=22:x=14:y=51,` +
      `drawtext=fontfile=${font}:textfile=${quote(timerPath)}:fontcolor=white:fontsize=22:x=14:y=86:enable='lt(t,${d})',` +
      `drawtext=fontfile=${font}:text='Elapsed ${d.toFixed(3)} s / ${d.toFixed(3)} s':fontcolor=white:fontsize=22:x=14:y=86:enable='gte(t,${d})',` +
      (note ? `drawtext=fontfile=${font}:textfile=${quote(notePath)}:expansion=none:fontcolor=yellow:fontsize=22:x=14:y=124:enable='gte(t,${noteAt})',` : '') +
      `drawbox=x=0:y=${canvasHeight - 40}:w=${panelWidth}:h=40:color=black@0.8:t=fill:enable='gte(t,${d})',` +
      `drawtext=fontfile=${font}:text='Finished - actual verification tail':fontcolor=white:fontsize=23:x=14:y=${canvasHeight - 32}:enable='between(t,${d},${d + 3})',` +
      `drawtext=fontfile=${font}:text='Finished - last frame held':fontcolor=white:fontsize=23:x=14:y=${canvasHeight - 32}:enable='gt(t,${d + 3})'[p${index}]`);
  }
  filters.push(`[p0][p1]hstack=inputs=2,trim=duration=${total.toFixed(6)},setsar=1,drawbox=x=${panelWidth - 1}:y=0:w=2:h=${canvasHeight}:color=white@0.6:t=fill[out]`);
  const filterPath = `${output}.filter`;
  await writeFile(filterPath, filters.join(';\n'), { flag: 'wx' });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin', '-n', ...inputArgs,
    '-filter_complex_script', filterPath, '-map', '[out]', '-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '4.0',
    '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-r', '15', '-fps_mode', 'cfr', '-g', '15', '-movflags', '+faststart', output]);
  const finalInfo = await probe(output);
  const check = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-i', output,
    '-vf', 'blackdetect=d=0.05:pix_th=0.10:pic_th=0.80', '-f', 'null', '-']);
  const poster = `${output}.poster.png`, review = `${output}.review.png`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', output, '-frames:v', '1', poster]);
  const last = Number(finalInfo.nb_frames) - 1;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', output, '-vf',
    `select='eq(n,0)+eq(n,${Math.floor(last / 2)})+eq(n,${last})',scale=640:-2,tile=3x1`, '-frames:v', '1', review]);
  Object.assign(metadata, { status: /black_start:/.test(check.stderr) ? 'needs_review' : 'completed', finalInfo, poster, review,
    fullDecodePassed: true, blackIntervalsDetected: /black_start:/.test(check.stderr), endedAtEpochMs: Date.now() });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  process.stdout.write(`${JSON.stringify({ status: metadata.status, output, poster, review, metadataPath })}\n`);
  if (metadata.status !== 'completed') process.exitCode = 1;
} catch (error) {
  const allowed = ['INVALID_ARGUMENTS', 'INVALID_PATH', 'OUTPUT_EXISTS', 'INVALID_RECORDING', 'MEDIA_TOOL_FAILED'];
  const reason = allowed.includes(error.message) ? error.message : 'RENDER_FAILED';
  if (metadataCreated) await writeFile(metadataPath, JSON.stringify({ ...metadata, status: 'failed', reason }, null, 2)).catch(() => {});
  process.stderr.write(`${JSON.stringify({ status: 'failed', reason })}\n`); process.exitCode = 1;
} finally { await log?.close().catch(() => {}); }
