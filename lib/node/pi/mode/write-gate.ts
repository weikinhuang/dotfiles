/**
 * Per-mode write-scope gate. Decides whether a `write` / `edit` tool
 * call should be allowed, prompted, or blocked based on the active
 * mode's resolved `writeRoots` plus the session-allow cache and the
 * runtime's UI availability. Pure module — no pi imports — so the
 * decision tree is unit-tested directly under vitest.
 *
 * The helper stops *before* the actual `askForPermission` prompt: when
 * the decision is `prompt`, the extension shell is responsible for
 * dispatching the prompt, interpreting the response, and (on
 * `allow-session`) populating the `sessionAllow` cache the caller
 * passes back in on subsequent calls.
 *
 * See `plans/pi-mode-extension.md` decisions D3 (ask-on-violation),
 * D8 (no realpath — symlink-escapes inherit the link path).
 */

import { isInsideWriteRoots } from './match.ts';

export type WriteGateDecision =
  /** Inside `writeRoots`, or the path is in `sessionAllow`. Caller proceeds. */
  | { kind: 'allow' }
  /** Outside `writeRoots`, UI present. Caller awaits `askForPermission`. */
  | { kind: 'prompt'; detail: string }
  /** Outside `writeRoots`, no UI, `violationDefault` is `'deny'`. Caller blocks. */
  | { kind: 'block'; reason: string };

export interface WriteGateOptions {
  /** Already-resolved absolute path the tool wants to write/edit. */
  absolutePath: string;
  /** As-typed input path (used in the no-UI block reason for context). */
  inputPath: string;
  /** Mode's `writeRoots` after substitution + cwd-resolution. */
  resolvedWriteRoots: readonly string[];
  /** Paths the user OK'd this session via `Allow this session`. */
  sessionAllow: ReadonlySet<string>;
  /** Whether the runtime can show an approval prompt. */
  hasUI: boolean;
  /** `PI_MODE_VIOLATION_DEFAULT` resolved value, only consulted when `!hasUI`. */
  violationDefault: 'allow' | 'deny';
  /** Used to compose human-readable reason strings. */
  modeName: string;
}

/**
 * Resolve a per-mode write-scope decision. Order of checks:
 *
 *   1. `absolutePath` is in `sessionAllow` → `allow` (cached approval).
 *   2. `resolvedWriteRoots` non-empty AND `absolutePath` inside → `allow`.
 *   3. UI available → `prompt`. Caller dispatches `askForPermission`.
 *   4. No UI, `violationDefault === 'allow'` → `allow`.
 *   5. No UI, `violationDefault === 'deny'` → `block`.
 *
 * The `detail` / `reason` strings name the active mode and its roots
 * so the model gets actionable context whether the gate prompts or
 * blocks. Empty `resolvedWriteRoots` is treated as "writes disallowed
 * entirely" for the purpose of the prompt/block reason text.
 */
export function decideWriteGate(opts: WriteGateOptions): WriteGateDecision {
  const { absolutePath, inputPath, resolvedWriteRoots, sessionAllow, hasUI, violationDefault, modeName } = opts;

  if (sessionAllow.has(absolutePath)) {
    return { kind: 'allow' };
  }

  const insideRoots = resolvedWriteRoots.length > 0 && isInsideWriteRoots(absolutePath, resolvedWriteRoots);
  if (insideRoots) {
    return { kind: 'allow' };
  }

  const detail =
    resolvedWriteRoots.length === 0
      ? `mode "${modeName}" disallows writes`
      : `mode "${modeName}" writeRoots: ${resolvedWriteRoots.join(', ')}`;

  if (hasUI) {
    return { kind: 'prompt', detail };
  }

  if (violationDefault === 'allow') {
    return { kind: 'allow' };
  }

  return {
    kind: 'block',
    reason:
      `No UI for approval. Path "${inputPath}" is outside ${detail}. ` +
      'Set PI_MODE_VIOLATION_DEFAULT=allow to override, or pick a path under writeRoots.',
  };
}
