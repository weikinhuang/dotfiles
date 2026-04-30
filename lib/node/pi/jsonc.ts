/**
 * Tiny JSONC parser: JSON plus `//` line comments and C-style block
 * comments. Trailing commas are NOT supported — keep your hand-edited
 * rule files strict so `git diff` stays clean.
 *
 * Designed to be zero-dep, small enough to audit, and to preserve line
 * numbers across stripped comments so that `JSON.parse` errors point at
 * the line in the original source file.
 *
 * Lives in `lib/` (pure, no pi imports) so it can be unit-tested under
 * `vitest`.
 */

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

    // Enter a string literal — emit verbatim up to the closing quote,
    // honoring backslash escapes so `"a\"b"` stays one string.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (text[i] === '\\') {
          // Skip the backslash and whatever it escapes (might be `\n`,
          // `\t`, `\"`, `\\`, `\uXXXX`, etc. — JSON.parse validates).
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
 * Parse a JSONC string. Equivalent to `JSON.parse(stripJsonComments(text))`.
 * Throws the same `SyntaxError` shape as `JSON.parse` on malformed input.
 */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}
