import type { BackendId } from './vocab.js';

/** One model a backend's CLI offers, as its adapter reports it without a model call (plan 4.1 `listModels`). */
export interface ModelInfo {
  /** The id a seat config names in `model`. */
  id: string;
  /** Model family, e.g. `anthropic`, `openai`, `xai`, `google`. Drives the same-family warnings (plan 5.2). */
  family: string;
}

/** The slice of the adapter contract (plan 4.1) that config validation needs. */
export interface ModelLister {
  listModels(): Promise<readonly ModelInfo[]>;
}

/**
 * Looks up the adapter for a backend. Seat adapters arrive in P2-P4; P0 ships this interface and a fake
 * registry in the tests. A backend with no adapter returns `undefined`, and config validation treats that as
 * an error, because a seat with no adapter cannot run.
 */
export interface AdapterRegistry {
  lister(backend: BackendId): ModelLister | undefined;
}
