import type { AdapterRegistry, ModelInfo, ModelLister } from '../src/config/index.js';
import type { BackendId } from '../src/config/vocab.js';

/** Model lists for the fake registry. Families follow the model's maker, not the CLI that serves it. */
export const FAKE_MODELS: Partial<Record<BackendId, ModelInfo[]>> = {
  codex: [
    { id: 'gpt-6.1-sol', family: 'openai' },
    { id: 'gpt-5.6-sol', family: 'openai' },
  ],
  kiro: [
    { id: 'gpt-5.6-sol', family: 'openai' },
    { id: 'claude-sonnet-5.5', family: 'anthropic' },
  ],
  claude: [
    { id: 'claude-sonnet-5-5', family: 'anthropic' },
    { id: 'claude-opus-5-5', family: 'anthropic' },
  ],
  grok: [{ id: 'grok-4.7', family: 'xai' }],
  antigravity: [{ id: 'gemini-3.8-pro', family: 'google' }],
};

export interface FakeRegistry extends AdapterRegistry {
  /** How many times each backend's list was read. */
  calls: Map<BackendId, number>;
}

export function fakeRegistry(
  models: Partial<Record<BackendId, ModelInfo[] | Error>> = FAKE_MODELS,
): FakeRegistry {
  const calls = new Map<BackendId, number>();
  return {
    calls,
    lister(backend: BackendId): ModelLister | undefined {
      const entry = models[backend];
      if (entry === undefined) return undefined;
      return {
        listModels: async () => {
          calls.set(backend, (calls.get(backend) ?? 0) + 1);
          if (entry instanceof Error) throw entry;
          return entry;
        },
      };
    },
  };
}
