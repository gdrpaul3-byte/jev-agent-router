#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// File-only rendering: this module never captures a screen or drives a browser.
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const TAIL_SECONDS = 3;
const FPS = 15;
const modes = ['normal', 'jev'];
const labels = ['Normal Codex', 'JEV goal'];
const required = ['--normal', '--normal-trial', '--jev', '--jev-trial', '--output'];
const accepted = [...required, '--normal-recording', '--jev-recording'];
const withinWorkspace = path => { const rel = relative(workspace, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const quote = value => `'${value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''")}'`;
const positiveEpoch = value => Number.isSafeInteger(value) && value > 0;

/** Pure, testable timeline calculation; epochs establish playback and elapsedMs supplies the measured label. */
export function buildGoalComparison(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 2) throw new Error('INVALID_TRIAL');
  const trials = inputs.map((input, index) => {
    const { trial, recording, sourceInfo } = input ?? {};
    if (!trial || !positiveEpoch(trial.startedAtEpochMs) || !positiveEpoch(trial.endedAtEpochMs)
      || trial.endedAtEpochMs <= trial.startedAtEpochMs || typeof trial.verified !== 'boolean'
      || !Number.isFinite(trial.elapsedMs) || trial.elapsedMs <= 0 || trial.elapsedMs > 1800000) throw new Error('INVALID_TRIAL');
    const epochDurationMs = trial.endedAtEpochMs - trial.startedAtEpochMs;
    // Wall and monotonic measurements may differ by rounding, but not by omitted setup/work.
    if (epochDurationMs > 1800000 || Math.abs(epochDurationMs - trial.elapsedMs) > 100) throw new Error('TRIAL_TIMING_MISMATCH');
    if (!recording || recording.exitCode !== 0 || recording.errorCode
      || !Number.isFinite(recording.inputStartEpochSeconds) || recording.inputStartEpochSeconds <= 0) throw new Error('INVALID_RECORDING');
    const sourceDuration = Number(sourceInfo?.duration);
    if (!Number.isSafeInteger(sourceInfo?.width) || !Number.isSafeInteger(sourceInfo?.height)
      || sourceInfo.width < 2 || sourceInfo.height < 2 || sourceInfo.width > 8192 || sourceInfo.height > 8192
      || !Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('INVALID_RECORDING');
    const startSeconds = (trial.startedAtEpochMs - recording.inputStartEpochSeconds * 1000) / 1000;
    const durationSeconds = epochDurationMs / 1000;
    const captureSeconds = durationSeconds + TAIL_SECONDS;
    // Never manufacture the post-completion tail from a freeze or silently shorten it.
    if (startSeconds < 0 || startSeconds + captureSeconds > sourceDuration + 1 / FPS) throw new Error('INSUFFICIENT_REAL_RECORDING');
    return { mode: modes[index], label: labels[index], source: input.source, recordingPath: input.recordingPath,
      trialPath: input.trialPath, startedAtEpochMs: trial.startedAtEpochMs, endedAtEpochMs: trial.endedAtEpochMs,
      elapsedMs: trial.elapsedMs, verified: trial.verified, epochDurationMs, startSeconds, durationSeconds,
      measuredSeconds: trial.elapsedMs / 1000, captureSeconds, sourceDurationSeconds: sourceDuration,
      sourceWidth: sourceInfo.width, sourceHeight: sourceInfo.height };
  });
  const totalSeconds = Math.max(...trials.map(trial => trial.captureSeconds));
  const panelWidth = Math.ceil(Math.min(960, Math.max(...trials.map(trial => trial.sourceWidth))) / 2) * 2;
  for (const trial of trials) {
    trial.freezeSeconds = Math.max(0, totalSeconds - trial.captureSeconds);
    trial.scaledHeight = Math.max(2, Math.round(trial.sourceHeight * panelWidth / trial.sourceWidth / 2) * 2);
  }
  const panelHeight = Math.max(...trials.map(trial => trial.scaledHeight));
  if (panelHeight > 8192) throw new Error('INVALID_RECORDING');
  return { trials, totalSeconds, panelWidth, panelHeight, headerHeight: 126,
    playbackSpeed: 1, fps: FPS, tailSeconds: TAIL_SECONDS };
}

async function readJSON(path) {
  if (!withinWorkspace(path) || extname(path).toLowerCase() !== '.json') throw new Error('INVALID_PATH');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1000000) throw new Error('INVALID_METADATA');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}
async function mustNotExist(path) {
  try { await access(path); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('OUTPUT_EXISTS'); }
}

export async function renderGoalVideo(options) {
  const output = resolve(options['--output']);
  if (!withinWorkspace(output) || extname(output).toLowerCase() !== '.mp4') throw new Error('INVALID_PATH');
  const metadataPath = `${output}.render.json`, logPath = `${output}.stderr.log`;
  const poster = `${output}.poster.png`, review = `${output}.review.png`, filterPath = `${output}.filter`;
  const timerPaths = modes.map(mode => `${output}.${mode}-timer.txt`);
  for (const path of [output, metadataPath, logPath, poster, review, filterPath, ...timerPaths]) await mustNotExist(path);
  let log, metadata, metadataCreated = false;
  async function run(command, args) {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000000); });
    const code = await new Promise(done => child.once('close', done));
    if (log) await log.write(`${command}\n${stderr}\n`);
    if (spawnFailed || code !== 0) throw new Error('MEDIA_TOOL_FAILED');
    return { stdout, stderr };
  }
  const probe = async path => JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,duration,nb_frames', '-of', 'json', path])).stdout).streams?.[0];
  try {
    const inputs = [];
    for (const mode of modes) {
      const source = resolve(options[`--${mode}`]);
      if (!withinWorkspace(source) || extname(source).toLowerCase() !== '.mp4') throw new Error('INVALID_PATH');
      const trialPath = resolve(options[`--${mode}-trial`]);
      const recordingPath = resolve(options[`--${mode}-recording`] ?? resolve(dirname(source), 'recording.json'));
      inputs.push({ source, trialPath, recordingPath, trial: await readJSON(trialPath), recording: await readJSON(recordingPath), sourceInfo: await probe(source) });
    }
    const specification = buildGoalComparison(inputs);
    const { trials, totalSeconds, panelWidth, panelHeight, headerHeight } = specification;
    const canvasHeight = panelHeight + headerHeight;
    await mkdir(dirname(output), { recursive: true });
    log = await open(logPath, 'wx');
    metadata = { ...specification, output, source: 'Actual browser window recordings supplied by host',
      verificationSource: 'Host trial metadata; the renderer does not independently establish task completion',
      convention: 'Start aligned by recording and trial epochs. Each recording plays at 1x through its measured interval and 3 seconds of actual tail. Shorter panel freezes only after that tail. Timer stops at the trial end; displayed result uses supplied elapsedMs.',
      status: 'rendering', startedAtEpochMs: Date.now(), visualReviewRequired: true };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { flag: 'wx' }); metadataCreated = true;
    const filters = [], inputArgs = [], font = quote('C:/Windows/Fonts/arial.ttf');
    for (const [index, trial] of trials.entries()) {
      const duration = trial.durationSeconds, measured = trial.measuredSeconds.toFixed(3);
      const finishLabel = trial.verified ? 'Verified complete' : 'Stopped - NOT VERIFIED';
      const finishColor = trial.verified ? 'white' : 'yellow';
      await writeFile(timerPaths[index], `Elapsed %{pts:hms} / ${measured} s`, { flag: 'wx' });
      inputArgs.push('-ss', trial.startSeconds.toFixed(6), '-t', trial.captureSeconds.toFixed(6), '-i', trial.source);
      filters.push(`[${index}:v]setpts=PTS-STARTPTS,scale=${panelWidth}:${trial.scaledHeight},pad=${panelWidth}:${panelHeight}:0:(oh-ih)/2:color=black,setsar=1,` +
        `tpad=stop_mode=clone:stop_duration=${(trial.freezeSeconds + 0.2).toFixed(6)},pad=${panelWidth}:${canvasHeight}:0:${headerHeight}:color=0x111827,` +
        `drawtext=fontfile=${font}:text='${trial.label} - ${measured} seconds':fontcolor=white:fontsize=27:x=14:y=12,` +
        `drawtext=fontfile=${font}:text='Real window recording | 1x | same start':fontcolor=white:fontsize=21:x=14:y=51,` +
        `drawtext=fontfile=${font}:textfile=${quote(timerPaths[index])}:fontcolor=white:fontsize=22:x=14:y=86:enable='lt(t,${duration})',` +
        `drawtext=fontfile=${font}:text='Elapsed ${measured} s / ${measured} s':fontcolor=white:fontsize=22:x=14:y=86:enable='gte(t,${duration})',` +
        `drawbox=x=0:y=${canvasHeight - 40}:w=${panelWidth}:h=40:color=black@0.85:t=fill:enable='gte(t,${duration})',` +
        `drawtext=fontfile=${font}:text='${finishLabel} - real 3s tail':fontcolor=${finishColor}:fontsize=22:x=14:y=${canvasHeight - 32}:enable='between(t,${duration},${duration + TAIL_SECONDS})',` +
        `drawtext=fontfile=${font}:text='${finishLabel} - last frame held':fontcolor=${finishColor}:fontsize=22:x=14:y=${canvasHeight - 32}:enable='gt(t,${duration + TAIL_SECONDS})'[p${index}]`);
    }
    filters.push(`[p0][p1]hstack=inputs=2,trim=duration=${totalSeconds.toFixed(6)},setsar=1,drawbox=x=${panelWidth - 1}:y=0:w=2:h=${canvasHeight}:color=white@0.6:t=fill[out]`);
    await writeFile(filterPath, filters.join(';\n'), { flag: 'wx' });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin', '-n', ...inputArgs,
      '-filter_complex_script', filterPath, '-map', '[out]', '-an', '-c:v', 'libx264', '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-r', String(FPS), '-fps_mode', 'cfr', '-g', String(FPS), '-movflags', '+faststart', output]);
    const finalInfo = await probe(output);
    if (!finalInfo || Math.abs(Number(finalInfo.duration) - totalSeconds) > 2 / FPS
      || finalInfo.width !== panelWidth * 2 || finalInfo.height !== canvasHeight) throw new Error('OUTPUT_TIMELINE_MISMATCH');
    const decoded = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-i', output,
      '-vf', 'blackdetect=d=0.05:pix_th=0.10:pic_th=0.80', '-f', 'null', '-']);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', output, '-frames:v', '1', poster]);
    const last = Number(finalInfo.nb_frames) - 1;
    const reviewFrames = [...new Set([0, Math.min(last, Math.round(Math.min(...trials.map(trial => trial.durationSeconds)) * FPS)), Math.min(last, Math.round(Math.max(...trials.map(trial => trial.durationSeconds)) * FPS)), last])];
    const select = reviewFrames.map(frame => `eq(n,${frame})`).join('+');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', output, '-vf',
      `select='${select}',scale=640:-2,tile=${reviewFrames.length}x1`, '-frames:v', '1', review]);
    const blackIntervalsDetected = /black_start:/.test(decoded.stderr);
    Object.assign(metadata, { status: blackIntervalsDetected || trials.some(trial => !trial.verified) ? 'needs_review' : 'completed',
      finalInfo, poster, review, fullDecodePassed: true, blackIntervalsDetected, endedAtEpochMs: Date.now() });
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    return { status: metadata.status, output, poster, review, metadataPath };
  } catch (error) {
    if (metadataCreated) await writeFile(metadataPath, JSON.stringify({ ...metadata, status: 'failed', reason: safeReason(error) }, null, 2)).catch(() => {});
    throw error;
  } finally { await log?.close().catch(() => {}); }
}

function safeReason(error) {
  const allowed = ['INVALID_ARGUMENTS', 'INVALID_PATH', 'INVALID_TRIAL', 'TRIAL_TIMING_MISMATCH', 'INVALID_RECORDING', 'INSUFFICIENT_REAL_RECORDING', 'INVALID_METADATA', 'OUTPUT_EXISTS', 'MEDIA_TOOL_FAILED', 'OUTPUT_TIMELINE_MISMATCH'];
  return allowed.includes(error?.message) ? error.message : 'RENDER_FAILED';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!accepted.includes(args[index]) || options[args[index]] !== undefined || !args[index + 1]) throw new Error('INVALID_ARGUMENTS');
      options[args[index]] = args[index + 1];
    }
    if (required.some(flag => options[flag] === undefined)) throw new Error('INVALID_ARGUMENTS');
    const result = await renderGoalVideo(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', reason: safeReason(error) })}\n`);
    process.exitCode = 1;
  }
}
