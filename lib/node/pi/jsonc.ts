/**
 * Tiny JSONC parser: JSON plus `//` line comments, C-style block
 * comments, and trailing commas before `}` / `]`. Trailing-comma
 * tolerance mirrors pi's own config parser (`dist/utils/json.js`) so
 * this repo reads the exact `models.json` / `settings.json` files pi
 * accepts - a stricter parser here would silently no-op on a file pi
 * considers valid (see `llama-thinking-budget`). The standalone
 * {@link stripJsonComments} still removes comments only; trailing-comma
 * removal lives in {@link stripTrailingCommas} and is applied by
 * {@link parseJsonc}.
 *
 * Designed to be zero-dep, small enough to audit, and to preserve line
 * numbers across stripped comments so that `JSON.parse` errors point at
 * the line in the original source file.
 *
 * Lives in `lib/` (pure, no pi imports) so it can be unit-tested under
 * `vitest`.
 */

import { readFileSync } from 'node:fs';

/**
 * Return `text` with `//` line comments and C-style block comments
 * replaced by nothing (line comments) or spaces/newlines (block
 * comments, to preserve line numbers). Comment markers inside JSON
 * string literals are left alone.
 *
 * Edge cases handled:
 *   - `"//"` inside strings is NOT stripped.
 *   - Block-comment openers inside strings are NOT stripped.
 *   - Escaped quotes (`"a\"b"`) don't prematurely end the string.
 *   - URLs (`"https://example.com"`) pass through untouched.
 *   - Multi-line block comments preserve their embedded newlines so
 *     `JSON.parse` error line numbers still line up with the source.
 *   - Unterminated block comments consume the remainder of the input
 *     (conservative; the subsequent `JSON.parse` will raise a clear
 *     error about the missing `}` / `]` instead).
 */
export function stripJsonComments(text: string): string {
  let out = '';
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    // Enter a string literal - emit verbatim up to the closing quote,
    // honoring backslash escapes so `"a\"b"` stays one string.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (text[i] === '\\') {
          // Skip the backslash and whatever it escapes (might be `\n`,
          // `\t`, `\"`, `\\`, `\uXXXX`, etc. - JSON.parse validates).
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += text.slice(start, i);
      continue;
    }

    // Line comment: drop everything up to (but not including) `\n`.
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      // Leave the `\n` for the next iteration to emit, so line numbers
      // in downstream JSON errors still align.
      continue;
    }

    // Block comment: drop the markers and body, but preserve embedded
    // newlines so line numbers stay aligned.
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2; // skip `*/` (harmless if we ran off the end)
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Remove trailing commas that sit immediately before a `}` or `]`
 * (ignoring intervening whitespace). String literals are matched first
 * by the alternation so a `,}` inside a string (`{"a":"x,}"}`) is left
 * untouched. Mirrors pi's `stripJsonComments` trailing-comma pass.
 *
 * Run this AFTER {@link stripJsonComments} so a comment body containing
 * `,}` has already been removed and can't be mistaken for a trailing
 * comma.
 */
export function stripTrailingCommas(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m: string, tail: string | undefined) => tail ?? m);
}

/**
 * Parse a JSONC string. Equivalent to
 * `JSON.parse(stripTrailingCommas(stripJsonComments(text)))`: strips
 * `//` + block comments, then removes trailing commas. Throws the same
 * `SyntaxError` shape as `JSON.parse` on malformed input.
 */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text))) as T;
}

/**
 * Dedup-on-error console warning helper shared by rule-file loaders. Each
 * unique {path, error-message} pair logs once; a successful re-parse (call
 * `clearConfigWarning(path)`) re-arms the slot so a subsequent break is
 * reported again.
 *
 * Exists to keep the "warn once per bad config file" pattern identical
 * across the security-gate extensions (`bash-permissions`, `filesystem`,
 * `sandbox`).
 */
const warnedBadConfigFiles = new Map<string, string>();

export function warnBadConfigFileOnce(tag: string, path: string, error: unknown): void {
  const msg = String(error);
  const key = `${tag}\0${path}`;
  if (warnedBadConfigFiles.get(key) === msg) return;
  warnedBadConfigFiles.set(key, msg);
  console.warn(`[${tag}] failed to parse ${path}: ${msg}`);
}

export function clearConfigWarning(tag: string, path: string): void {
  warnedBadConfigFiles.delete(`${tag}\0${path}`);
}

/**
 * Read + parse a JSONC config file with the "missing is fine, malformed
 * warns once" policy. Used by single-file config loaders
 * (`bash-permissions`, `filesystem-policy/load`, …) so the
 * read/parse/warn/clear plumbing isn't re-implemented in each one.
 *
 * Behavior:
 *   - Missing or unreadable file → return `fallback()` silently.
 *   - Successful parse → `clearConfigWarning(tag, path)` then return value.
 *   - Parse error → `warnBadConfigFileOnce(tag, path, e)` then return
 *     `fallback()`. The fallback is invoked lazily so callers can pass a
 *     factory for the failure-only allocation.
 */
export function loadJsoncConfigOrFallback<T>(tag: string, path: string, fallback: () => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return fallback();
  }
  try {
    const parsed = parseJsonc<T>(raw);
    clearConfigWarning(tag, path);
    return parsed;
  } catch (e) {
    warnBadConfigFileOnce(tag, path, e);
    return fallback();
  }
}

export interface ConfigWarning {
  path: string;
  error: string;
}

export interface TryReadJsoncOptions {
  /**
   * Require the parsed root to be a non-array object. Adds an explicit
   * "config root must be an object" warning when the file parses to a
   * string / number / array / null. Default `false` (accept any JSON
   * value).
   */
  requireObject?: boolean;
}

/**
 * Read + parse a JSONC file as part of a multi-path layered loader
 * (`bash-exit-watchdog`, `iteration-loop-config`, `small-model-addendum`,
 * `verify-hook-detect`). Each layer either contributes a parsed value or
 * pushes a `ConfigWarning` for the caller to surface verbatim.
 *
 * Behavior:
 *   - Missing or unreadable file → return `undefined` silently (no warning).
 *   - Parse error → push `{path, error}` to `warnings`, return `undefined`.
 *   - `opts.requireObject` set AND root is not a plain object → push
 *     `{path, error: "config root must be an object"}`, return `undefined`.
 *   - Otherwise → return the parsed value verbatim.
 */
export function tryReadJsoncFile(path: string, warnings: ConfigWarning[], opts: TryReadJsoncOptions = {}): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (e) {
    warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
  if (opts.requireObject) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push({ path, error: 'config root must be an object' });
      return undefined;
    }
  }
  return parsed;
}

/**
 * Thrown by {@link readJsoncForMutation} when the file exists but fails to
 * parse. Slash-command handlers that mutate JSONC config files in place
 * (network allow/deny lists, write-allow paths, …) catch this and abort
 * the write with a user-facing notify, so a malformed-but-recoverable
 * file is never clobbered. The `path` field is set so the handler's
 * notify can name the offending file directly.
 */
export class JsoncReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`Failed to parse ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JsoncReadError';
    this.path = path;
  }
}

/**
 * Read + parse a JSONC config file for a read-then-mutate-then-write
 * cycle. Distinct from {@link loadJsoncConfigOrFallback}'s warn-then-
 * fallback policy: a file that EXISTS but fails to parse throws
 * {@link JsoncReadError} so the caller can abort rather than silently
 * overwrite a user's hand-edited rules + comments.
 *
 * Behavior:
 *   - Missing or unreadable file → `fallback()` (a fresh write is fine).
 *   - Empty / whitespace-only file → `fallback()` (treat as new).
 *   - Parse error → emit a one-shot `warnBadConfigFileOnce(tag, path, e)`
 *     then throw {@link JsoncReadError}.
 *   - Successful parse → return the parsed value verbatim. (No
 *     `clearConfigWarning` call here; that's the read-only loader's job.)
 */
export function readJsoncForMutation<T>(tag: string, path: string, fallback: () => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return fallback();
  }
  if (!raw.trim()) return fallback();
  try {
    return parseJsonc<T>(raw);
  } catch (e) {
    warnBadConfigFileOnce(tag, path, e);
    throw new JsoncReadError(path, e);
  }
}
