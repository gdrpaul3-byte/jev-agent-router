#!/usr/bin/env node
// File-only presentation edit. Task-clock mode requires timestamp-verified source clips.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARMS = ['astra', 'jev'];
const FPS = 25;
const sha = data => createHash('sha256').update(data).digest('hex');
const fail = code => { throw new Error(code); };
export function comparisonTimeline(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 2) fail('INVALID_INPUT');
  const sharedHash = inputs[0]?.report?.protocol?.comparisonHash;
  if (!/^[a-f0-9]{64}$/.test(sharedHash ?? '')) fail('INVALID_PROTOCOL');
  const taskAligned = inputs.every(input => input.media?.taskAlignment?.kind === 'browser-task-clock');
  if (!taskAligned && inputs.some(input => input.media?.taskAlignment)) fail('MIXED_CLOCKS');
  const panels = inputs.map(({ report, media }, index) => {
    if (report?.arm !== ARMS[index] || report.status !== 'completed' || report.result?.passed !== true
      || report.protocol?.comparisonHash !== sharedHash || media?.validPixels !== true
      || media.width !== 1600 || media.height !== 900 || !Number.isInteger(media.frames) || media.frames < 3
      || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > 1800
      || Math.abs(media.frames / FPS - media.durationSeconds) > 0.01
      || !Number.isFinite(report.timing?.taskDurationMs) || report.timing.taskDurationMs <= 0
      || report.result.cost?.complete !== true || !Number.isFinite(report.result.cost.accountedProviderUsd)) fail('INVALID_INPUT');
    if (taskAligned && (report.taskClock?.status !== 'aligned'
      || media.taskAlignment.sourceManifestSha256 !== report.taskClock.sha256
      || !/^[a-f0-9]{64}$/.test(report.taskClock.sha256 ?? '')
      || !Number.isFinite(media.taskAlignment.measuredTaskSeconds)
      || Math.abs(media.taskAlignment.measuredTaskSeconds * 1000 - report.timing.taskDurationMs) > 0.001
      || media.frames !== Math.ceil(report.timing.taskDurationMs / 40))) fail('INVALID_TASK_ALIGNMENT');
    return { arm: ARMS[index], jevUsed: index === 1, clipSeconds: media.durationSeconds, sourceFrames: media.frames,
      measuredTaskSeconds: report.timing.taskDurationMs / 1000, providerUsd: report.result.cost.accountedProviderUsd,
      clockEndSeconds: taskAligned ? report.timing.taskDurationMs / 1000 : media.durationSeconds,
      sourceSha256: media.mp4Sha256 };
  });
  const totalSeconds = Math.max(...panels.map(panel => panel.clipSeconds)) + 2;
  return { comparisonHash: sharedHash, fps: FPS, width: 2560, height: 1000, totalSeconds,
    panels: panels.map(panel => ({ ...panel, heldSeconds: totalSeconds - panel.clipSeconds })),
    taskAligned,
    alignment: taskAligned ? 'Both t=0 points are the measured task start before initial model inference. Browser presentation timestamps map frames to this clock at 25fps.'
      : 'Both complete source clips begin at replay t=0. Exact task-start frame alignment is unknown.',
    clock: taskAligned ? 'Measured task elapsed seconds, capped at task completion including final extraction.'
      : 'Replay seconds, capped at each source clip end; measured task seconds are separate static labels.',
    speed: 1, cuts: taskAligned ? 'Setup and cleanup excluded; entire measured task retained.' : false, finalPresentationTailSeconds: 2 };
}

async function run(command, args, cwd) {
  return new Promise((ok, reject) => {
    let child; try { child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new Error('MEDIA_TOOL_START_FAILED')); return; }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-100000); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-200000); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('MEDIA_TOOL_START_FAILED')); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('MEDIA_TOOL_FAILED')); else ok({ stdout, stderr }); });
  });
}
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const quoted = value => `'${value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''")}'`;

export async function renderComparison({ root, outputDir, font }) {
  const sourceRoot = resolve(root), output = resolve(outputDir), fontFile = resolve(font);
  const inputs = await Promise.all(ARMS.map(async arm => ({
    report: await readJson(join(sourceRoot, arm, 'report.json')),
    media: await readJson(join(sourceRoot, arm, 'media.json')),
  })));
  const timeline = comparisonTimeline(inputs);
  for (const panel of timeline.panels) {
    const source = join(sourceRoot, panel.arm, 'video.mp4');
    if (sha(await readFile(source)) !== panel.sourceSha256) fail('SOURCE_HASH_MISMATCH');
    const info = JSON.parse((await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames,avg_frame_rate,duration', '-of', 'json', source])).stdout).streams?.[0];
    if (info?.width !== 1600 || info.height !== 900 || Number(info.nb_frames) !== panel.sourceFrames
      || info.avg_frame_rate !== '25/1' || Math.abs(Number(info.duration) - panel.clipSeconds) > 0.01) fail('SOURCE_MEDIA_MISMATCH');
  }
  await readFile(fontFile); // Fail before creating output if the requested bilingual font is missing.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // New directory only, preserving original clips and prior edits.
  const filters = [], inputArgs = [];
  for (const [index, panel] of timeline.panels.entries()) {
    const prefix = `panel-${index}`, accent = index === 0 ? '0xc4d2ea' : '0x67e8c4';
    const labels = {
      badge: index === 0 ? 'JEV 미사용  /  NO JEV' : 'JEV 사용  /  WITH JEV',
      model: index === 0 ? 'Astra 판단 + Astra 추출' : 'JEV 판단 + Astra 추출',
      timer: `${timeline.taskAligned ? '업무 경과 / Task' : '영상 재생 / Replay'}  %{eif:floor(t):d:2}.%{eif:mod(floor(t*10),10):d} s`,
      stopped: `${timeline.taskAligned ? '업무 완료 / Done' : '영상 재생 / Replay'}  ${panel.clockEndSeconds.toFixed(2)} s  ·  END`,
      measured: `실측 업무 / Task ${panel.measuredTaskSeconds.toFixed(2)} s   |   API $${panel.providerUsd.toFixed(5)}`,
      running: timeline.taskAligned ? '실제 업무 시작 = 0초 · 1x / Task start aligned' : '원본 시작 동시 재생 · 1x / Both clips start together',
      held: timeline.taskAligned ? '업무 완료 · 결과 화면 유지 / Task done · final frame held' : '클립 끝 · 마지막 화면 유지 / Clip ended · final frame held',
      note: timeline.taskAligned ? '판단·대기·최종 추출 포함 / Includes decisions, waits & extraction' : '초는 영상 기준 · 업무 실측은 준비/정리 제외 / Task excludes setup & cleanup',
    };
    for (const [name, value] of Object.entries(labels)) await writeFile(join(output, `${prefix}-${name}.txt`), value, { flag: 'wx' });
    const text = (name, size, x, y, color = 'white', enable = '') =>
      `drawtext=fontfile=${quoted(fontFile)}:textfile='${prefix}-${name}.txt':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}${enable ? `:enable='${enable}'` : ''}`;
    inputArgs.push('-protocol_whitelist', 'file', '-i', join(sourceRoot, panel.arm, 'video.mp4'));
    filters.push(`[${index}:v]setpts=PTS-STARTPTS,scale=1280:720:flags=lanczos,setsar=1,` +
      `tpad=stop_mode=clone:stop_duration=${panel.heldSeconds.toFixed(6)},pad=1280:1000:0:200:color=0x0b1220,` +
      `drawbox=x=0:y=0:w=1280:h=6:color=${accent}:t=fill,` +
      text('badge', 36, 28, 21, accent) + ',' + text('model', 34, 28, 66) + ',' +
      text('timer', 38, 28, 111, 'white', `lt(t,${panel.clockEndSeconds})`) + ',' +
      text('stopped', 38, 28, 111, accent, `gte(t,${panel.clockEndSeconds})`) + ',' +
      text('measured', 25, 28, 164, '0xcbd5e1') + ',' +
      text('running', 25, 28, 932, '0xcbd5e1', `lt(t,${panel.clockEndSeconds})`) + ',' +
      text('held', 25, 28, 932, accent, `gte(t,${panel.clockEndSeconds})`) + ',' +
      text('note', 23, 28, 969, '0x94a3b8') + `[p${index}]`);
  }
  filters.push(`[p0][p1]hstack=inputs=2,trim=duration=${timeline.totalSeconds.toFixed(6)},drawbox=x=1278:y=0:w=4:h=1000:color=0x64748b:t=fill[out]`);
  await writeFile(join(output, 'comparison.filter'), filters.join(';\n'), { flag: 'wx' });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...inputArgs,
    '-filter_complex_threads', '2', '-filter_complex_script', 'comparison.filter', '-map', '[out]', '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25', '-fps_mode', 'cfr',
    '-movflags', '+faststart', 'comparison.mp4'], output);
  const final = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,duration,nb_read_frames,avg_frame_rate', '-of', 'json', 'comparison.mp4'], output)).stdout).streams?.[0];
  if (final?.width !== timeline.width || final.height !== timeline.height || final.avg_frame_rate !== '25/1'
    || Number(final.nb_read_frames) !== Math.round(timeline.totalSeconds * FPS)
    || Math.abs(Number(final.duration) - timeline.totalSeconds) > 0.01) fail('OUTPUT_TIMELINE_MISMATCH');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', String(Math.min(10, timeline.totalSeconds / 2)), '-i', 'comparison.mp4', '-frames:v', '1', 'poster.png'], output);
  const frames = [...new Set([0, Math.floor(timeline.totalSeconds * FPS / 4), Math.floor(timeline.totalSeconds * FPS / 2),
    ...timeline.panels.flatMap(panel => [Math.max(0, Math.ceil(panel.clockEndSeconds * FPS) - 1), Math.ceil(panel.clockEndSeconds * FPS)]), Number(final.nb_read_frames) - 1])].sort((a,b) => a-b);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', 'comparison.mp4',
    '-vf', `select='${frames.map(frame => `eq(n,${frame})`).join('+')}',scale=1280:500,tile=2x4`, '-frames:v', '1', 'review.png'], output);
  const metadata = { schemaVersion: 1, ...timeline, sources: ARMS.map(arm => `${arm}/video.mp4`),
    sourceScope: timeline.taskAligned ? 'Fresh benchmark recordings with browser presentation timestamps; editing makes no additional model calls.' : 'Previously reviewed full browser recordings; no new model calls.',
    fullDecodePassed: true, final, sha256: sha(await readFile(join(output, 'comparison.mp4'))),
    files: { video: 'comparison.mp4', poster: 'poster.png', review: 'review.png' }, visualReviewRequired: true };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  return metadata;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length !== 6) fail('EXPECTED_ROOT_OUTPUT_DIR_FONT');
    for (let index = 0; index < args.length; index += 2) {
      const key = { '--root': 'root', '--output-dir': 'outputDir', '--font': 'font' }[args[index]];
      if (!key || options[key] || !args[index + 1]) fail('INVALID_ARGUMENTS'); options[key] = args[index + 1];
    }
    console.log(JSON.stringify(await renderComparison(options)));
  } catch (error) { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = 1; }
}
