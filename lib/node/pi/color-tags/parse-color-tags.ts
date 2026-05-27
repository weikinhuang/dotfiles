/**
 * Inline color-tag rewriter for the `color-tags` pi extension.
 *
 * Replaces `[c:NAME]content[/c]` spans inside an assistant message
 * text fragment with ANSI SGR sequences resolved through
 * `ColorResolver`. The result is the same string with the bracket tags
 * swapped out for `<open(NAME)>content<close>`.
 *
 * **Why brackets, not guillemets / curly / HTML.** Earlier shapes were
 * rejected for two different reasons. The HTML-ish form `<color>…
 * </color>` collides with marked's tag tokenizer. The guillemet form
 * `«c:NAME»…«/c»` survives the API but trips Claude's pretrained
 * "guillemet+color = ANSI escape" reflex - the model auto-converts
 * some tags to raw `\x1b[…m` bytes and partially strips others.
 * Verified by hex-dumping `pi -p` raw output against opus-4-7 and
 * qwen3-6-35b-a3b: bracket form `[c:NAME]content[/c]` survives
 * end-to-end, marked tokenises it as plain text (not a link reference,
 * because there is no following `(href)`), and JSON / code / task-list
 * markers do not collide with it.
 *
 * Three passes the rewriter runs, in order:
 *   1. Fully-closed pair `[c:red]hello[/c]` → `<open>hello<close>`.
 *      Always handled, both streaming and non-streaming.
 *   2. Open without close `[c:red]still typing` (mid-stream) →
 *      `<open>still typing`. Only handled when `streaming: true`,
 *      because non-streaming callers shouldn't see partial spans.
 *   3. Orphan close cleanup `[/c]` → `\x1b[39m`. Streaming only.
 *      Reason: pi's agent-core mutates `content.text += delta`, so
 *      a previous chunk's pass-2 rewrite of `[c:NAME]still typing`
 *      → `\x1b[31mstill typing` persists into the next chunk. When
 *      the close `[/c]` finally arrives appended to the cumulative
 *      text, there is no longer a `[c:NAME]` open to pair it with -
 *      pass 1 sees nothing, and the close would otherwise stay
 *      literal on screen. Replacing it with the close ANSI is safe
 *      because a default-fg reset with no active foreground is a
 *      no-op for the terminal.
 *
 * **No partial-open suppression.** A previous version had a fourth
 * pass that stripped trailing `[c:re` / `[c:` / `[c` mid-stream to
 * avoid flicker. That was a destructive mutation: agent-core's
 * `text += delta` accumulation meant the stripped bytes were never
 * recovered, and the next chunk's `d]still typing[/c]` arrived
 * appended to a text where `[c:re` had been silently deleted -
 * leaving `:red]still typing` literal forever. The cure was worse
 * than the disease, so we accept a one-frame literal `[c:re` flash
 * instead.
 *
 * Unknown color names leave the literal tag in place. Silent-drop is
 * harder to debug than visible failure; the user / model can correct
 * the name on the next attempt.
 *
 * Nested `[c:...]` inside another span is treated as part of the
 * outer span's content (the regex is non-greedy and takes the first
 * `[/c]`).
 *
 * Pure module - no pi runtime, no `@earendil-works/*` imports.
 */

export interface ResolvedColor {
  open: string;
  close: string;
}

export type ColorResolver = (name: string) => ResolvedColor | undefined;

export interface RewriteOptions {
  /**
   * When true, also rewrite trailing open-without-close spans (case 2)
   * and suppress trailing partial-open prefixes (case 3). Pass `true`
   * during streaming where each chunk may end mid-tag, and `false` for
   * already-finalised text.
   */
  streaming?: boolean;
}

/**
 * Match a fully-closed `[c:NAME]content[/c]` pair. Non-greedy so
 * nested `[c:...]` inside the content gets absorbed into the outer
 * span and the FIRST `[/c]` we hit closes the span - matches the
 * model-facing "no nesting" rule.
 *
 * Group 1: color name. Group 2: span content.
 *
 * The negative lookahead at the start of the name (`[^\]\s]`) prevents
 * matching empty `[c:]` opens or names that start with whitespace.
 */
const CLOSED_TAG = /\[c:([^\]\s][^\]]*)\]([\s\S]*?)\[\/c\]/g;

/**
 * Match a trailing `[c:NAME]rest` with no closing `[/c]` to the
 * right. Used during streaming to color partial spans before the
 * close arrives.
 *
 * Group 1: color name. Group 2: span content (the rest of the
 * string).
 *
 * Anchored with `$` because we only want to match at the END of the
 * input - if there's another `[c:` followed by a `[/c]` later in the
 * stream chunk, the closed-pair pass already handled it.
 */
const OPEN_TAIL = /\[c:([^\]\s][^\]]*)\](?!.*\[\/c\])([\s\S]*)$/;

/**
 * Match a literal close tag `[/c]` anywhere in the string. Pass 3
 * uses this to clean up orphans left behind by pass 2's destructive
 * rewrite (see the four-pass description in the module header).
 */
const LITERAL_CLOSE = /\[\/c\]/g;

/** ANSI SGR for "reset foreground only" - keeps bold / italic / theme styling alive. */
const CLOSE_FG = '\x1b[39m';

/**
 * Rewrite color tags in `input`. The result is a new string; `input`
 * is not mutated.
 */
export function rewriteColorTags(input: string, resolver: ColorResolver, options: RewriteOptions = {}): string {
  if (input.length === 0) return input;

  // Pass 1: fully-closed pairs. Non-greedy, so we only consume as far
  // as the first `[/c]`. Run-of-the-mill `String.replace` with a
  // function callback - resolver returning undefined leaves the
  // literal text in place.
  let out = input.replace(CLOSED_TAG, (match, rawName: string, content: string) => {
    const resolved = resolver(rawName);
    if (!resolved) return match;
    return `${resolved.open}${content}${resolved.close}`;
  });

  if (!options.streaming) return out;

  // Pass 2 (streaming only): a trailing open-without-close. The
  // OPEN_TAIL regex's `(?!.*\[\/c\])` lookahead ensures we don't
  // double-wrap a span that pass 1 already handled.
  const openMatch = OPEN_TAIL.exec(out);
  if (openMatch) {
    const [, rawName, content] = openMatch;
    const resolved = resolver(rawName);
    if (resolved) {
      const head = out.slice(0, openMatch.index);
      out = `${head}${resolved.open}${content}`;
    }
  }

  // Pass 3 (streaming only): replace any remaining literal `[/c]`
  // with the close ANSI. After pass 1 every closed pair is gone, and
  // any leftover `[/c]` must be either an orphan from a previous
  // chunk's pass-2 rewrite (we ate the open before the close
  // arrived) or a close the model emitted with no matching open.
  // Both convert to `\x1b[39m` safely - a default-fg reset with no
  // active foreground is a no-op.
  out = out.replace(LITERAL_CLOSE, CLOSE_FG);

  return out;
}
