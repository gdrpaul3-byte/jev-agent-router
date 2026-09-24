import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCuaWorkflow } from '../src/cua.mjs';
import { prepareStart, goal, steps, directSelector } from './hsmu-run.mjs';

// An illustrative replay, intentionally separate from speed measurements.
export async function recordCheckpoints({ target, selector, root, mode }) {
  if (!['direct', 'jev'].includes(mode)) throw new Error('INVALID_MODE');
  await prepareStart(target);
  const directory = join(root, `checkpoint-${mode}`);
  await mkdir(directory, { recursive: true });
  const start = performance.now();
  const manifest = { format: 'sequential-checkpoint-replay', startedAt: new Date().toISOString(), frames: [], steps: [], errors: [], mode,
    limitation: 'Separate illustrative execution. Screenshots only at verified checkpoints; not continuous footage and not the measured benchmark.' };
  const capture = async (label) => {
    const captureStartedMs = performance.now() - start;
    const bytes = await target.getScreenshot({ emit: false });
    const capturedAtMs = performance.now() - start;
    const filename = `frame-${String(manifest.frames.length).padStart(6, '0')}.png`;
    await writeFile(join(directory, filename), bytes);
    manifest.frames.push({ filename, label, captureStartedMs, capturedAtMs });
  };
  try {
    await capture('homepage');
    for (let index = 0; index < steps.length; index++) {
      const result = await runCuaWorkflow({ target, selector: mode === 'direct' ? directSelector : selector, goal,
        steps: [steps[index]], maxSteps: 1, maxDurationMs: 30000, verificationTimeoutMs: 10000 });
      manifest.steps.push(result);
      if (result.status !== 'completed') break;
      await capture(index === 0 ? 'directions' : 'homepage-return');
    }
  } catch { manifest.errors.push({ code: 'REPLAY_CAPTURE_OR_HOST_FAILED', atMs: performance.now() - start }); }
  manifest.durationMs = performance.now() - start;
  manifest.finalUrl = await target.url();
  manifest.success = manifest.steps.length === 2 && manifest.steps.every(step => step.status === 'completed') && manifest.frames.length === 3;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { directory, ...manifest };
}
