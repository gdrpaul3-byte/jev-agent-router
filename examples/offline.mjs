import { createSelector } from '../src/selector.mjs';
import { runCuaWorkflow } from '../src/cua.mjs';

export const demoSteps = Object.freeze([
  { instruction: 'Open library', action: 'click', expect: { textIncludes: 'Choose an article' } },
  { instruction: 'Read guide', action: 'click', expect: { textIncludes: 'Workflow verified' } },
]);

// Deliberately fake inference. Never calls fetch or reads a real API key.
// Used to test the API contract and orchestration, not JEV quality or speed.
export function createOfflineSelector() {
  return createSelector({
    apiKey: 'offline-demo-not-a-real-key',
    fetchImpl: async (_url, { body }) => {
      const request = JSON.parse(body);
      const target = request.state.observation.elements.find(element =>
        element.name === request.state.instruction || element.description === request.state.instruction);
      const choice = target ? `e_${target.ref}` : 'NONE';
      const probabilities = Object.fromEntries(Object.keys(request.questions.target.criteria).map(key => [key, key === choice ? 1 : 0]));
      return {
        ok: true,
        json: async () => ({
          model: 'jev-offline-mock', usage: { input_tokens: 0, output_tokens: 0 },
          answers: { target: { type: 'choice', choice, confidence: 1, probabilities } },
        }),
      };
    },
  });
}

export async function runOfflineDemo() {
  const screens = [
    '0 AXWebArea JEV local demo\n\t1 button Open library',
    '0 AXWebArea JEV local demo\n\t1 text Choose an article\n\t2 button Read guide',
    '0 AXWebArea JEV local demo\n\t1 text Workflow verified',
  ];
  let screen = 0;
  const target = {
    getAXState: async () => screens[screen],
    click: async ref => {
      if (ref !== screen + 1) throw new Error('Unexpected demo target');
      screen++;
    },
  };
  const selector = createOfflineSelector();
  const result = await runCuaWorkflow({ target, selector, goal: 'Open the local guide', steps: demoSteps });
  return { mode: 'offline-mock', liveJev: false, ...result, usage: selector.stats() };
}
