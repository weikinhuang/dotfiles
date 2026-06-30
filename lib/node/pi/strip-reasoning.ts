/**
 * strip-reasoning core - drop plain-text `thinking` blocks from assistant
 * history before they are resent to the model.
 *
 * Problem: with `reasoning: true` (e.g. gemma / qwen via llama.cpp), pi stores
 * each thinking trace as a `thinking` block and the OpenAI-completions client
 * re-attaches EVERY past assistant turn's reasoning on each replayed message.
 * That round-trip is load-bearing for signed-thinking models (Claude / OpenAI
 * responses) but dead weight for models that emit plain-text reasoning: they do
 * not need their own past chain-of-thought resent to stay coherent, and on a
 * small window it can eat ~15% of the budget and pull auto-compaction forward
 * for no benefit.
 *
 * This module is the pure logic behind the `strip-reasoning` extension: the
 * stripping pass, the per-block safety predicate, and the layered config loader.
 * No pi imports - directly unit-testable under vitest.
 */

import { readJsonOrUndefined } from './fs-safe.ts';
import { piAgentPath, piProjectPath } from './pi-paths.ts';

/**
 * Signatures llama.cpp / OpenAI-completions use as a field-name sentinel (not a
 * real cryptographic signature). Reasoning carrying one of these - or none - is
 * plain text and safe to drop. Anything else (Anthropic signed thinking,
 * encrypted reasoning) is treated as load-bearing and preserved.
 */
export const SENTINEL_SIGNATURES = new Set(['reasoning_content', 'reasoning', 'reasoning_text']);

/** Default number of trailing assistant turns whose reasoning is always kept. */
export const DEFAULT_KEEP_LAST = 1;

export interface ReasoningBlock {
  type?: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ReasoningMessage {
  role?: string;
  content?: unknown;
}

export interface StripReasoningConfig {
  /** Allowlist of `provider/id` or bare `id` models whose reasoning is stripped. */
  models: string[];
  /** Trailing assistant turns whose reasoning is always preserved. */
  keepLast: number;
}

/**
 * A thinking block is stripable only when it is plain text: not redacted, and
 * either unsigned or carrying a known field-name sentinel signature. A real
 * opaque signature is preserved, so listing a signed-thinking model is a no-op
 * rather than a broken request.
 */
export function isStripableThinking(block: ReasoningBlock): boolean {
  if (block.type !== 'thinking') return false;
  if (block.redacted) return false;
  const sig = block.thinkingSignature;
  return !sig || SENTINEL_SIGNATURES.has(sig);
}

/**
 * Return a new message list with stripable `thinking` blocks removed from every
 * assistant message EXCEPT the last `keepLast` assistant messages (so an
 * in-flight tool loop still sees the immediately-preceding trace). Returns the
 * SAME array reference when nothing changed (cache-stable: an identical token
 * prefix lets the backend reuse its prefix cache). Never emits a content-less
 * assistant message - if every block was stripable thinking, the message is
 * left untouched.
 */
export function stripReasoning<T extends ReasoningMessage>(messages: readonly T[], keepLast: number): readonly T[] {
  const assistantIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.content)) assistantIdx.push(i);
  });
  const preserve = new Set(assistantIdx.slice(Math.max(0, assistantIdx.length - Math.max(0, keepLast))));

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || preserve.has(i)) return m;
    const content = m.content as ReasoningBlock[];
    if (!content.some(isStripableThinking)) return m;
    const filtered = content.filter((b) => !isStripableThinking(b));
    if (filtered.length === 0) return m;
    changed = true;
    return { ...m, content: filtered };
  });

  return changed ? out : messages;
}

/**
 * Decide whether `model` (its `id` and optional `provider`) is on the allowlist.
 * Matches on the bare `id` or on the qualified `provider/id`.
 */
export function shouldStripForModel(
  models: readonly string[],
  id: string | undefined,
  provider: string | undefined,
): boolean {
  if (id === undefined) return false;
  const set = new Set(models);
  if (set.has(id)) return true;
  return provider !== undefined && set.has(`${provider}/${id}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one untrusted JSON layer into a partial config. */
export function coerceStripReasoningLayer(raw: unknown): { models?: string[]; keepLast?: number } {
  if (!isObject(raw)) return {};
  const out: { models?: string[]; keepLast?: number } = {};
  if (Array.isArray(raw.models)) {
    out.models = raw.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim());
  }
  if (typeof raw.keepLast === 'number' && Number.isFinite(raw.keepLast) && raw.keepLast >= 0) {
    out.keepLast = Math.floor(raw.keepLast);
  }
  return out;
}

/**
 * Merge a user-scope and a project-scope layer. The `models` allowlist is the
 * UNION of both layers (a project can add models without restating the user's
 * list); `keepLast` is project > user > default.
 */
export function mergeStripReasoningLayers(
  user: { models?: string[]; keepLast?: number },
  project: { models?: string[]; keepLast?: number },
): StripReasoningConfig {
  const models = Array.from(new Set([...(user.models ?? []), ...(project.models ?? [])]));
  const keepLast = project.keepLast ?? user.keepLast ?? DEFAULT_KEEP_LAST;
  return { models, keepLast };
}

/**
 * Load + merge the layered config: project `.pi/strip-reasoning.json` over user
 * `<agentDir>/strip-reasoning.json`. A missing / unreadable / invalid file
 * contributes an empty layer, so the default is an empty allowlist (no-op).
 */
export function loadStripReasoningConfig(cwd: string): StripReasoningConfig {
  const user = coerceStripReasoningLayer(readJsonOrUndefined(piAgentPath('strip-reasoning.json')));
  const project = coerceStripReasoningLayer(readJsonOrUndefined(piProjectPath(cwd, 'strip-reasoning.json')));
  return mergeStripReasoningLayers(user, project);
}
