/**
 * Markdown code-region segmenter shared by the inline-marker rewriters
 * (`color-tags`, `avatar` emotes).
 *
 * Inline markers like `[c:NAME]content[/c]` or `[emote:NAME]` that fall
 * inside a fenced code block (```` ``` ```` / `~~~`) or an inline code
 * span (`` `...` ``) are LITERALS the user wants verbatim -
 * documentation and examples that show the marker syntax, snippets that
 * happen to contain bracket text, etc. A rewriter must leave those
 * untouched instead of acting on them.
 *
 * `splitCodeSegments(text)` slices `text` into an ordered list of
 * `{ text, code }` runs. The caller rewrites only the `code: false`
 * runs and concatenates the `code: true` runs back verbatim. Slicing
 * (rather than a per-offset mask consulted inside each pass) is what
 * keeps a regex pass from pairing an open INSIDE code with a close
 * OUTSIDE it - a code run is opaque, so no match can straddle the
 * boundary.
 *
 * **Streaming-stable by construction.** Run boundaries are decided
 * entirely by OPENING delimiters - the fence line above a block, the
 * backtick to the left of an inline span. For any content INSIDE a
 * region, its opener has already streamed into the cumulative text by
 * the time the content arrives, and left context never changes under
 * agent-core's `content.text += delta` accumulation. So earlier runs
 * are fixed the moment they exist and never reshuffle on a later chunk -
 * critical, because the rewriter bakes its mutations and can't take
 * them back. An unterminated opener (a stray backtick, an unclosed
 * fence) puts everything after it into a trailing code run, which
 * matches a user who typed a delimiter and meant "code from here on".
 *
 * **Inline spans use backtick-RUN parity, not full CommonMark.** A
 * backtick run toggles inline-code state for the rest of its line; an
 * even number of runs before a position means "outside", odd means
 * "inside". This handles single- and multi-backtick delimiters
 * (`` `x` ``, ``` ``x`` ``) without implementing CommonMark's
 * matched-run-length rule; pathological inputs degrade gracefully to
 * "code or not", never to a crash. Inline state resets each line
 * because a Markdown code span cannot cross a newline.
 *
 * Pure module - no pi runtime, no `@earendil-works/*` imports.
 */

/**
 * A fenced-code delimiter LINE: optional leading whitespace then a run
 * of 3+ backticks or 3+ tildes. The backticks/tildes must start the
 * line (after indentation) so an inline triple-backtick mid-prose
 * (`use ``` literally`) is NOT mistaken for a fence opener.
 */
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;

/** One ordered run of `text`, flagged as code (verbatim) or prose. */
export interface CodeSegment {
  text: string;
  code: boolean;
}

/** True when `line` opens or closes a fenced code block. */
export function isFenceLine(line: string): boolean {
  return FENCE_LINE.test(line);
}

/**
 * Slice `text` into ordered code / prose runs. Adjacent runs of the
 * same kind are coalesced, so a no-code string returns a single
 * `{ text, code: false }` run (the rewriter's fast path).
 */
export function splitCodeSegments(text: string): CodeSegment[] {
  // Fast path: no code delimiters at all -> one prose run.
  if (!text.includes('`') && !text.includes('~')) {
    return [{ text, code: false }];
  }

  const segments: CodeSegment[] = [];
  const push = (chunk: string, code: boolean): void => {
    if (chunk.length === 0) return;
    const last = segments[segments.length - 1];
    if (last?.code === code) {
      last.text += chunk;
    } else {
      segments.push({ text: chunk, code });
    }
  };

  const lines = text.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    // The newline that `split` removed belongs to whichever region the
    // boundary sits in: inside an open fence it is code, otherwise prose.
    if (li > 0) push('\n', inFence);

    const line = lines[li];
    if (inFence || FENCE_LINE.test(line)) {
      push(line, true);
      if (FENCE_LINE.test(line)) inFence = !inFence;
      continue;
    }

    // Prose line: walk backtick runs, toggling inline-code state. The
    // delimiter run itself is emitted as code; since code runs are
    // reproduced verbatim, which side a delimiter lands on never changes
    // the output - it only matters that tags inside the span are code.
    let inCode = false;
    let i = 0;
    while (i < line.length) {
      if (line[i] === '`') {
        let j = i + 1;
        while (j < line.length && line[j] === '`') j++;
        push(line.slice(i, j), true);
        inCode = !inCode;
        i = j;
      } else {
        let j = i + 1;
        while (j < line.length && line[j] !== '`') j++;
        push(line.slice(i, j), inCode);
        i = j;
      }
    }
  }

  // An entirely-empty text (no lines) still needs one prose run so the
  // caller's concat produces ''.
  if (segments.length === 0) segments.push({ text: '', code: false });
  return segments;
}
