import { createDecider } from './decider.mjs';
import { loadApiKey } from './config.mjs';
import { createMeteredFetch, summarizeBilling } from './meter.mjs';
import { proposeClaudeChrome, authorizeClaudeChrome, verifyClaudeChromeAction } from './claude-chrome.mjs';

const MAX_INPUT_BYTES = 1000000;
const stop = reason => ({ status: 'needs_host', reason });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounds = { timeoutMs: [1, 60000], maxInputBytes: [1, MAX_INPUT_BYTES], minConfidence: [0.75, 1], minMargin: [0.1, 1] };

/** Only whitelisted numeric decision limits; endpoints, keys and tools cannot be configured. */
export function validApiOptions(api) {
  return record(api) && !Object.entries(api).some(([key, value]) => !bounds[key] || !Number.isFinite(value)
    || value < bounds[key][0] || value > bounds[key][1] || (key === 'maxInputBytes' && !Number.isSafeInteger(value)));
}

/** Callable wrapper and CLI share exactly the same validation/cost path. */
export async function runClaudeChromeCommand(command, input, { envFile, apiKey = '', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (command === 'authorize') return authorizeClaudeChrome(input, { now });
  if (command === 'verify') return verifyClaudeChromeAction(input, { now });
  if (command !== 'decide') return stop('INVALID_ARGUMENTS');
  const api = input?.api ?? {};
  if (!validApiOptions(api)) return stop('INVALID_API_OPTIONS');
  const meter = createMeteredFetch({ fetchImpl });
  // Key loading is delayed until the envelope/plan/history have passed validation.
  const decider = { decide: async payload => {
    try {
      const key = await loadApiKey({ apiKey, envFile });
      return await createDecider({ apiKey: key, fetchImpl: meter.fetchImpl, maxCalls: 1, timeoutMs: 5000, maxInputBytes: 100000, ...api }).decide(payload);
    } catch (error) {
      return stop(['JEV_CONFIG_READ_ERROR', 'JEV_CONFIG_INVALID'].includes(error?.message) ? error.message : 'DECISION_FAILED');
    }
  } };
  const result = await proposeClaudeChrome(input, { decider, now });
  const usage = await meter.flush({ timeoutMs: 2000 });
  return { ...result, usage, cost: summarizeBilling(usage), requests: meter.records() };
}
