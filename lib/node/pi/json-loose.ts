/**
 * Tolerant JSON recovery from model output. Local models (and even
 * frontier ones) routinely wrap a requested JSON object in a code fence,
 * preface it with chatter, or trail it with commentary. These pure
 * helpers recover the object anyway, so each domain parser
 * (`comfyui/enhance.ts`'s enhance parser, `comfyui/refine.ts`'s
 * {@link CriticDecision} parser, the refiner, …) can focus on validating
 * the recovered shape rather than on string-wrangling.
 *
 * No pi imports - `node:*` + peer `lib/node/**` only. Extracted verbatim
 * from `comfyui/enhance.ts` (the original home) so multiple callers share
 * one definition; behaviour is identical to that original.
 */

/**
 * Strip a single wrapping ``` / ```json code fence, if present. A string
 * that does not start with a fence is returned trimmed but otherwise
 * untouched.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  // Drop the opening fence line (``` optionally followed by a tag) and a
  // trailing fence line.
  const withoutOpen = trimmed.replace(/^```[^\n]*\n?/, '');
  return withoutOpen.replace(/\n?```\s*$/, '').trim();
}

/**
 * Extract the first balanced `open … close` substring, or `null` when
 * none. The scan is depth-aware and string-aware (delimiters and escapes
 * inside `"…"` string literals do not affect depth), so nested structures
 * and delimiters embedded in string values stay balanced. `open` and
 * `close` must be distinct single characters (`{`/`}` or `[`/`]`).
 */
export function extractBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract the first balanced `{ … }` substring, or `null` when none.
 * Thin wrapper over {@link extractBalanced}: brace-depth aware and
 * string-aware, so nested objects and braces embedded in string values
 * stay balanced.
 */
export function extractBalancedObject(text: string): string | null {
  return extractBalanced(text, '{', '}');
}

/**
 * Extract the first balanced `[ … ]` substring, or `null` when none. The
 * array sibling of {@link extractBalancedObject}: bracket-depth aware and
 * string-aware, so nested arrays and brackets embedded in string values
 * stay balanced. Model "return a JSON array" responses routinely arrive
 * fenced or wrapped in prose, so callers that expect a top-level array
 * (valid JSON) recover it with this.
 */
export function extractBalancedArray(text: string): string | null {
  return extractBalanced(text, '[', ']');
}

/**
 * Parse `text` as JSON, falling back to a code-fence strip and then to
 * the first balanced object or array embedded in surrounding prose.
 * Returns `undefined` (never throws) when nothing parses - distinct from
 * a literal `null` JSON value, which parses fine and is returned as
 * `null`.
 *
 * Recovery order:
 *   1. `JSON.parse(text)` verbatim.
 *   2. `JSON.parse` of the text with a wrapping ```/```json fence stripped
 *      (a common model-output shape that is otherwise invalid JSON).
 *   3. The first balanced `{…}` or `[…]` structure embedded in the
 *      (unfenced) text, preferring whichever opens first so a
 *      prose-wrapped array of objects recovers the array, not its first
 *      element.
 */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to fence stripping + balanced extraction.
  }

  const unfenced = stripCodeFence(text);
  if (unfenced !== text) {
    try {
      return JSON.parse(unfenced);
    } catch {
      // Fall through to balanced extraction on the unfenced text.
    }
  }

  const objAt = unfenced.indexOf('{');
  const arrAt = unfenced.indexOf('[');
  const objectFirst = arrAt === -1 || (objAt !== -1 && objAt < arrAt);
  const candidates = objectFirst
    ? [extractBalancedObject(unfenced), extractBalancedArray(unfenced)]
    : [extractBalancedArray(unfenced), extractBalancedObject(unfenced)];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate structure.
    }
  }
  return undefined;
}
