/**
 * Sandbox re-entry marker + identity-wrap helpers.
 *
 * Extracted from `config/pi/extensions/sandbox.ts` so the helpers are
 * unit-testable under vitest without dragging in the full extension
 * (which imports from `@earendil-works/pi-coding-agent` and is excluded
 * from the root `tsconfig.json`). Pure module - no pi imports.
 *
 * The marker `__PI_SANDBOX_WRAPPED=1` is prepended to wrapped commands
 * so the bash hook can detect and skip already-wrapped commands
 * (re-entry guard), and stripped from user input before wrapping so a
 * model that learns the marker can't bypass the wrap (sanitization).
 *
 * The `SANDBOX_ORIGINAL_SYMBOL` is the property key used to stash the
 * pre-wrap command on `event.input`, so transcript renderers and
 * `bash-permissions` allow-rule saves can prefer the original over the
 * rewritten value.
 */

/** Re-entry marker prepended to wrapped commands. */
export const SANDBOX_MARKER = '__PI_SANDBOX_WRAPPED=1';

/** Symbol-keyed property where sandbox.ts stashes the original command
 *  on `event.input`. Symbol-keyed (not string-keyed) so transcript
 *  serializers that JSON-stringify `event.input` skip it. */
export const SANDBOX_ORIGINAL_SYMBOL = Symbol.for('@dotfiles/pi/sandbox/originalCommand');

/** Symbol-keyed property where sandbox.ts stashes the per-wrap list of
 *  dangerous-file stub paths it created/adopted on `event.input`, so
 *  the matching `tool_result` hook can decrement their refcount and
 *  unlink the ones whose count drops to zero. Symbol-keyed for the
 *  same JSON-serializer-invisibility reason as the original-command
 *  stash above. */
export const SANDBOX_STUBS_SYMBOL = Symbol.for('@dotfiles/pi/sandbox/createdStubs');

/** True when `command` already starts with the sandbox re-entry
 *  marker. Tested against the leading non-whitespace prefix so a user-
 *  prefixed `   __PI_SANDBOX_WRAPPED=1 ...` is also detected. */
export function alreadyWrapped(command: string): boolean {
  return command.trimStart().startsWith(SANDBOX_MARKER);
}

/**
 * Strip any pre-existing `__PI_SANDBOX_WRAPPED=1 ` prefixes from the
 * user-supplied command. Defends against a model that learns the
 * marker and tries to short-circuit the wrap. Stacked markers
 * (`__PI_SANDBOX_WRAPPED=1 __PI_SANDBOX_WRAPPED=1 ...`) collapse to
 * the bare command via the inner loop.
 */
export function stripMarkerFromUserInput(command: string): string {
  let cur = command;
  while (true) {
    const trimmed = cur.replace(/^[\s;]+/, '');
    if (!trimmed.startsWith(`${SANDBOX_MARKER} `)) {
      return trimmed;
    }
    cur = trimmed.slice(SANDBOX_MARKER.length + 1);
  }
}

import { shQuote } from '../util.ts';

/**
 * Build the identity-wrap shell-string used when ASRT itself can't be
 * initialized (missing deps, identity-wrap mode) but we still want the
 * marker present so downstream re-entry guards work consistently.
 *
 * Format:  `__PI_SANDBOX_WRAPPED=1 sh -c '<command>'`
 *
 * Note: the prefix is purely advisory in v1 - the real kernel sandbox
 * happens via ASRT's own injection. We keep the prefix on every wrap
 * attempt so the re-entry guard never has to second-guess.
 */
export function buildIdentityWrap(original: string): string {
  return `${SANDBOX_MARKER} sh -c ${shQuote(original)}`;
}

// ───────────────────────────────────────────────────────────────────────
// Original-command stash helpers. Used by sandbox.ts's `tool_call`
// hook to mark an event as already-wrapped and to recover the
// pre-wrap command for transcript / bash-history consumers.
// ───────────────────────────────────────────────────────────────────────

/**
 * True when `input` already carries our original-command stash,
 * meaning a previous sandbox hook pass wrapped it. Symbol-keyed so
 * a model cannot fabricate it (Symbols can't appear in JSON input).
 */
export function hasOriginalStash(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false;
  return (input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL] !== undefined;
}

/**
 * Stash the pre-wrap command on `input` under {@link SANDBOX_ORIGINAL_SYMBOL}.
 * The property is non-enumerable so transcript serializers that
 * JSON-stringify `event.input` skip it.
 */
export function stashOriginalCommand(input: unknown, original: string): void {
  if (input === null || typeof input !== 'object') return;
  Object.defineProperty(input, SANDBOX_ORIGINAL_SYMBOL, {
    value: original,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Read the previously-stashed pre-wrap command from `input`. Returns
 * `undefined` if the stash isn't set or the input shape is unexpected.
 * Used by the `tool_result` hook to surface the original command in
 * audit-log records and the user-facing fs-ask dialog.
 */
export function readOriginalStash(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const v = (input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Stash the per-wrap list of dangerous-file stub paths on `input`
 * under {@link SANDBOX_STUBS_SYMBOL}. The list is a snapshot of the
 * paths `createDangerousFileStubs` actually touched (created or
 * adopted via the EEXIST path) for THIS wrap, so the matching
 * `tool_result` handler can decrement their refcount and unlink the
 * ones whose count has dropped to zero. Empty / undefined input is
 * silently ignored. Stored as a frozen copy so a downstream consumer
 * can't accidentally mutate the stash.
 */
export function stashCreatedStubs(input: unknown, paths: readonly string[]): void {
  if (input === null || typeof input !== 'object') return;
  Object.defineProperty(input, SANDBOX_STUBS_SYMBOL, {
    value: Object.freeze([...paths]),
    enumerable: false,
    configurable: true,
  });
}

/**
 * Read the per-wrap stub list previously stashed by
 * {@link stashCreatedStubs}. Returns an empty array when the stash is
 * absent or shaped unexpectedly, so the caller can iterate without a
 * null check.
 */
export function readCreatedStubs(input: unknown): readonly string[] {
  if (input === null || typeof input !== 'object') return [];
  const v = (input as Record<symbol, unknown>)[SANDBOX_STUBS_SYMBOL];
  if (!Array.isArray(v)) return [];
  // Defensive: every entry must be a string, otherwise drop it.
  return v.filter((x): x is string => typeof x === 'string');
}
