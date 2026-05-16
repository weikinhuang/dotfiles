/**
 * Pure helpers for the loop-breaker extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * Small self-hosted models regularly get stuck calling the same tool
 * with the same arguments repeatedly - most often `read` with the
 * same offset or `bash` with a command that keeps failing the same
 * way. They'll burn 5–10 turns before giving up.
 *
 * This module provides:
 *
 *   - `makeKey(toolName, input)` - canonical key for a tool call.
 *     Uses a stable JSON encoding so `{a:1,b:2}` and `{b:2,a:1}`
 *     hash identically.
 *   - `pushAndCheck(history, key, window, threshold)` - append a
 *     key to the rolling history window and report whether that key
 *     has repeated `threshold` times inside the window. The extension
 *     uses this to decide whether to fire a steering message.
 *   - `buildNudge(toolName, count)` - the short, directive message
 *     we inject as a followup when a repeat is detected.
 */

export type CallCheck = { kind: 'ok' } | { kind: 'repeat'; count: number };

/**
 * Stringify `value` with a stable key ordering. Intended to make
 * `makeKey('bash', { timeout: 30, command: 'x' })` and
 * `makeKey('bash', { command: 'x', timeout: 30 })` produce the same
 * key. Handles cycles by emitting `"[Circular]"` rather than throwing -
 * tool inputs shouldn't be cyclic, but defensive against fuzz tests.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    const record = v as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const k of keys) out[k] = walk(record[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Canonical key for a (toolName, input) pair. Always safe to use as
 * a Map key or an array element for deep-equality comparisons.
 */
export function makeKey(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input ?? {})}`;
}

/**
 * Mutate `history` in place: push `key`, keep only the last `window`
 * entries, then count how many times `key` appears in the retained
 * window. Returns `{ kind: 'repeat', count }` when the count meets
 * or exceeds `threshold`; `{ kind: 'ok' }` otherwise.
 *
 * The caller typically clears `history` on a repeat so the nudge
 * doesn't fire on the very next call when the model legitimately
 * tries once more while pivoting.
 */
export function pushAndCheck(history: string[], key: string, window: number, threshold: number): CallCheck {
  if (window <= 0 || threshold <= 0) return { kind: 'ok' };
  history.push(key);
  while (history.length > window) history.shift();
  let count = 0;
  for (const k of history) if (k === key) count++;
  if (count >= threshold) return { kind: 'repeat', count };
  return { kind: 'ok' };
}

/**
 * Steering message we inject via `pi.sendMessage({ deliverAs: 'steer' })`.
 * Deliberately terse and directive - the point is to break the loop,
 * not explain it philosophically.
 */
export function buildNudge(toolName: string, count: number): string {
  return (
    `You have now called \`${toolName}\` with identical arguments ${count} times in a row and received ` +
    `the same result each time. A different approach is required - either change the arguments, try a ` +
    `different tool, or ask the user for guidance. Do NOT retry \`${toolName}\` with the same arguments again.`
  );
}
