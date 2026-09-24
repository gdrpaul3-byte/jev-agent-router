import { createSelector } from './selector.mjs';
import { createDecider } from './decider.mjs';
import { runCuaWorkflow } from './cua.mjs';
import { runGoalWorkflow, prepareGoalPlan } from './goal.mjs';
import { loadApiKey } from './config.mjs';
import { createMeteredFetch, summarizeBilling } from './meter.mjs';

export { createSelector, createDecider, runCuaWorkflow, runGoalWorkflow, prepareGoalPlan, loadApiKey };
export { parseAX } from './cua.mjs';
export { createMeteredFetch, summarizeBilling } from './meter.mjs';
export { createCodexTarget } from './codex-target.mjs';
export { proposeClaudeChrome, authorizeClaudeChrome, verifyClaudeChromeAction } from './claude-chrome.mjs';
export { prepareRouteRequest, decideRoute } from './router.mjs';
export { decideRouteBatch } from './router-batch.mjs';
export { runRoutingTask, readReadyHandoff } from './router-task.mjs';
export { prepareStructuredRequest, runStructuredRequest } from './structured-llm.mjs';
export { prepareAdaptiveRoute, runAdaptiveRoute } from './adaptive-router.mjs';
export { createInferenceBudget } from './inference-budget.mjs';

/** Import in the SAME persistent REPL that holds the existing CUA target. */
export async function createCuaSession({ apiKey, envFile, ...selectorOptions } = {}) {
  const key = await loadApiKey({ apiKey, envFile });
  const meter = createMeteredFetch({ fetchImpl: selectorOptions.fetchImpl });
  const selector = createSelector({ ...selectorOptions, apiKey: key, fetchImpl: meter.fetchImpl });
  const decider = createDecider({ ...selectorOptions, timeoutMs: selectorOptions.timeoutMs === undefined ? 5000 : selectorOptions.timeoutMs, apiKey: key, fetchImpl: meter.fetchImpl });
  const maxCalls = selectorOptions.maxCalls ?? 50;
  const extraErrors = { workflow: 0, goal: 0 };
  let lastLatencyMs = 0;
  let busy = false;
  const modeStats = mode => {
    const snapshot = mode === 'goal' ? decider.stats() : selector.stats();
    return { ...snapshot, errors: snapshot.errors + extraErrors[mode] };
  };
  const stats = () => {
    const fixed = modeStats('workflow'), goal = modeStats('goal');
    return { calls: fixed.calls + goal.calls, inputTokens: fixed.inputTokens + goal.inputTokens,
      errors: fixed.errors + goal.errors, lastLatencyMs };
  };
  const invoke = (mode, operation, input) => {
    // No await between the shared-budget check and the creator's synchronous call reservation.
    if (Number.isSafeInteger(maxCalls) && maxCalls >= 0 && stats().calls >= maxCalls) {
      extraErrors[mode]++; lastLatencyMs = 0;
      return Promise.resolve({ status: 'needs_host', reason: 'CALL_BUDGET_EXHAUSTED', latencyMs: 0 });
    }
    return Promise.resolve(operation(input)).then(result => { lastLatencyMs = result.latencyMs; return result; });
  };
  const fixedSelector = { select: input => invoke('workflow', selector.select, input) };
  const goalDecider = { decide: input => invoke('goal', decider.decide, input) };
  const run = async (mode, options) => {
    if (busy) {
      extraErrors[mode]++;
      return { status: 'needs_host', reason: 'SESSION_BUSY', completedSteps: 0, steps: [], durationMs: 0 };
    }
    busy = true;
    try {
      return mode === 'goal' ? await runGoalWorkflow({ ...options, decider: goalDecider })
        : await runCuaWorkflow({ ...options, selector: fixedSelector });
    } finally { busy = false; }
  };
  return Object.freeze({
    configured: Boolean(key), stats,
    billingStats: () => summarizeBilling(meter.stats()),
    billingRecords: () => meter.records(),
    flushBilling: async options => summarizeBilling(await meter.flush(options)),
    workflowStats: () => modeStats('workflow'),
    goalStats: () => modeStats('goal'),
    workflow: options => run('workflow', options),
    goal: options => run('goal', options),
  });
}
