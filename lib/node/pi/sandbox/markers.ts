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

/** Single-quote-escape a shell argument. Single-quoted strings have no
 *  shell metacharacter expansion; embedded single quotes are escaped
 *  via `'\''` (close, escape literal, reopen). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

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
