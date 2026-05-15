/**
 * Pure helper for the `requestOptions` field on persona / agent
 * frontmatter. Pi exposes a `before_provider_request` extension event
 * whose handler can replace the outgoing provider payload — that is the
 * surface we use to inject arbitrary per-request fields (`temperature`,
 * `top_p`, `top_k`, `chat_template_kwargs`, OpenRouter routing, …)
 * without forking pi-ai.
 *
 * Pure module — no pi imports — so the merge + filter rules are
 * unit-testable under vitest. `applyRequestOptions` is called from the
 * extension's `before_provider_request` handler with the live payload
 * and the active persona's / agent's resolved `requestOptions`.
 *
 * ## Schema
 *
 * `requestOptions` is a free-form object whose top-level keys are
 * deep-merged into the outgoing payload. The one reserved key is `apis`,
 * a string array that scopes the override to one or more API families
 * (e.g. `["openai-completions"]`). When `apis` is omitted, the options
 * apply to every provider.
 *
 *     requestOptions:
 *       apis: [openai-completions]
 *       temperature: 0.7
 *       top_p: 0.95
 *       top_k: 40
 *       chat_template_kwargs:
 *         enable_thinking: true
 *
 * Nested objects merge recursively (so a persona can add
 * `chat_template_kwargs.enable_thinking` without nuking the
 * `preserve_thinking` key pi-ai already injects for the
 * qwen-chat-template thinking format). Arrays and primitives from the
 * override fully replace the original — last-write-wins, no
 * concatenation, no deep-equals — to keep semantics predictable.
 *
 * ## Why the `apis` filter
 *
 * Providers silently ignore unknown top-level keys most of the time,
 * but some (Anthropic Messages especially, and Bedrock Converse) reject
 * unrecognized fields with a 400. Setting `apis: [openai-completions]`
 * keeps a llama.cpp-only `chat_template_kwargs` block from leaking
 * into an Anthropic payload when the user changes models mid-session.
 */

/** Output of validating a raw frontmatter `requestOptions` block. */
export interface RequestOptionsConfig {
  /**
   * Optional API filter. When present and non-empty, the options apply
   * only when the live model's `api` is in this list. Omitted / empty
   * means "apply to every provider".
   */
  apis?: string[];
  /** Arbitrary keys merged into the provider payload. */
  [key: string]: unknown;
}

export interface ApplyRequestOptionsArgs {
  /**
   * Live provider payload (the body about to be sent over HTTP).
   * Provider-specific shape — opaque to this helper. Non-object payloads
   * are returned unchanged.
   */
  payload: unknown;
  /** Resolved persona / agent `requestOptions` block, or undefined. */
  options: RequestOptionsConfig | undefined;
  /**
   * The handling model's `api` (e.g. `"openai-completions"`,
   * `"anthropic-messages"`). When undefined, the `apis` filter is
   * treated as "no match" (so the merge is skipped) for safety.
   */
  api?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  // Accept plain objects (Object.create(null) or {}); reject class
  // instances which usually have meaningful identity.
  return proto === null || proto === Object.prototype;
}

/**
 * Recursive merge: for every key in `override`, if both sides are plain
 * objects we recurse, otherwise the override value wins. Arrays /
 * primitives from the override fully replace the original — they do
 * NOT concatenate. The merge produces a new top-level object so the
 * caller can hand it straight back to pi-ai without the original being
 * mutated.
 */
function deepMerge(target: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────

/**
 * Deep-merge `options` into `payload` according to the schema in the
 * module docstring. Returns the merged object (a new top-level object;
 * nested untouched branches are reused by reference). Returns `payload`
 * unchanged when:
 *
 *   - `options` is undefined, null, or contains no merge keys.
 *   - `payload` is not a plain object (string, array, null, …).
 *   - The `apis` filter is set and the live `api` doesn't match.
 */
export function applyRequestOptions(args: ApplyRequestOptionsArgs): unknown {
  const { payload, options, api } = args;
  if (!options) return payload;
  if (!isPlainObject(payload)) return payload;

  const apisFilter = Array.isArray(options.apis) ? options.apis.filter((a) => typeof a === 'string') : undefined;
  if (apisFilter && apisFilter.length > 0) {
    if (!api || !apisFilter.includes(api)) return payload;
  }

  const mergeKeys: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (k === 'apis') continue;
    mergeKeys[k] = v;
  }
  if (Object.keys(mergeKeys).length === 0) return payload;

  return deepMerge(payload, mergeKeys);
}

/**
 * Validate a raw frontmatter `requestOptions` value. Returns the parsed
 * config or `undefined` (with a warning pushed) when the shape is
 * unusable. The validation is intentionally permissive — only the
 * shapes the pure-helper relies on (top-level object, optional `apis`
 * string array) are enforced. Provider-specific keys are passed through
 * untouched.
 */
export function parseRequestOptions(
  raw: unknown,
  pushWarning: (reason: string) => void,
): RequestOptionsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    pushWarning('`requestOptions` must be an object');
    return undefined;
  }
  const result: RequestOptionsConfig = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'apis') {
      if (!Array.isArray(v)) {
        pushWarning('`requestOptions.apis` must be an array of strings (dropped)');
        continue;
      }
      const apis: string[] = [];
      for (const entry of v) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          pushWarning(`\`requestOptions.apis\` entry "${String(entry)}" is not a non-empty string (dropped)`);
          continue;
        }
        apis.push(entry);
      }
      if (apis.length > 0) result.apis = apis;
      continue;
    }
    result[k] = v;
  }
  // Empty object after filtering → treat as "no override".
  const remaining = Object.keys(result).filter((k) => k !== 'apis');
  if (remaining.length === 0 && !result.apis) return undefined;
  return result;
}
