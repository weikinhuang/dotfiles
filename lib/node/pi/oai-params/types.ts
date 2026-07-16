/**
 * Shared types and constants for the `oai-params` extension's pure
 * helpers. No pi imports - directly unit-testable.
 *
 * The extension defines *derived model variants*: a new pi model id that
 * `extends` an existing OpenAI-compatible model (the parent) and layers a
 * block of OpenAI-completions sampling params on top of every request.
 */

/** A JSON-serializable value, as it appears in `oai-params.json`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A validated sampling-param block (reserved keys already stripped). */
export type SamplingParams = Record<string, JsonValue>;

/**
 * Payload keys the extension will never touch. These are the fields pi's
 * `openai-completions` builder owns (structural + managed). `model` is
 * listed for completeness even though the hook rewrites it deliberately
 * (that rewrite is not driven by user sampling params).
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'store',
  'tools',
  'tool_choice',
  'max_tokens',
  'max_completion_tokens',
  'n',
]);

/** A single `oai-params.json` entry, parsed and validated. */
export interface ParsedVariant {
  /** The new pi model id (the JSON key). Also used as the synthetic provider name. */
  id: string;
  /** Display name shown in the model selector. Defaults to {@link id}. */
  name: string;
  /** Parent provider name (left of the `/` in `extends`). */
  parentProvider: string;
  /** Parent model id / real server id (right of the `/` in `extends`). */
  parentId: string;
  /** Sampling params to inject (fill-only) into every request for this variant. */
  samplingParams: SamplingParams;
}

/**
 * Everything the hook needs at request time, keyed by the synthetic
 * provider name (== variant id).
 */
export interface VariantInjection {
  /** Real server model id to rewrite `payload.model` to. */
  parentId: string;
  /** Sampling params to fill in. */
  samplingParams: SamplingParams;
}

/**
 * A structural mirror of pi's `ProviderModelConfig` (we can't import pi
 * types into a pure module). The extension shell casts this to the real
 * type at `registerProvider` time.
 */
export interface ModelRegistrationSpec {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: JsonValue };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: JsonValue;
  thinkingLevelMap?: JsonValue;
}

/**
 * A structural mirror of pi's `ProviderConfig` plus the provider name to
 * register it under. One provider per variant (single model).
 */
export interface ProviderRegistrationSpec {
  providerName: string;
  baseUrl: string;
  apiKey?: string;
  api: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelRegistrationSpec[];
}
