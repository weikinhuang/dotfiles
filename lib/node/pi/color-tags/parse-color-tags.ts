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
 * Four passes the rewriter runs, in order:
 *   1. Fully-closed pair `[c:red]hello[/c]` → `<open>hello<close>`.
 *      Always handled, both streaming and non-streaming. Content is
 *      line-bounded so a dropped `[/c]` can't steal a later line's
 *      close (see `CLOSED_TAG`). An UNKNOWN name here is unwrapped
 *      (`recoverUnknownPair`), not left literal.
 *   1b. Orphan-open recovery `recoverOrphanOpens`. Both modes. Any
 *      `[c:NAME]` pass 1 left behind (dropped close, lone open) is
 *      unwrapped when NAME is unknown - to its trailing content, or to
 *      the NAME itself when the open sits at a line end. Resolved opens
 *      are left literal (dropped-close stays a visible slip).
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
 *   4. Close dangling foreground at completed-line boundaries.
 *      Streaming only. A pass-2 open that the model never closes
 *      (it streamed on to the next line / row without emitting
 *      `[/c]`) leaves an active foreground baked into the ANSI; it
 *      then bleeds its color down through every following line. This
 *      pass appends `\x1b[39m` to any completed line that ends with
 *      an active foreground, containing the color to the one line the
 *      model broke. The still-typing last line is left alone.
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
 * Unknown color names are RECOVERED, not left literal. Small models
 * routinely emit a bogus name (`[c:special]...[/c]`), an empty pair
 * (`[c:special][/c]`), or a lone open (`[c:special]`) where the word
 * they meant to colour sits in the NAME slot. Rather than leave the
 * broken bracket text on screen, the rewriter unwraps it: a closed
 * pair / content-bearing open collapses to its content, and an empty
 * open collapses to the NAME itself. A RESOLVED colour with a dropped
 * close is the one case still left literal - a real name with a missing
 * `[/c]` is a recoverable slip we keep visible. See `recoverUnknownPair`
 * / `recoverOrphanOpens`.
 *
 * **Code regions are skipped entirely.** Before any pass runs, `input`
 * is sliced into Markdown code / prose runs (`splitCodeSegments` in
 * `../code-mask.ts`): fenced blocks (```` ``` ````/`~~~`) and inline code
 * spans (`` `...` ``) are reproduced verbatim - their `[c:NAME]` are
 * literals the user wants shown (docs / examples of this very syntax) -
 * and only prose runs are rewritten. Slicing (rather than masking
 * offsets inside each pass) is what stops a regex match from pairing an
 * open inside code with a close outside it. The slicing is keyed off
 * OPENING delimiters so it stays stable under streaming accumulation.
 *
 * Nested `[c:...]` inside another span is treated as part of the
 * outer span's content (the regex is non-greedy and takes the first
 * `[/c]`).
 *
 * Pure module - no pi runtime, no `@earendil-works/*` imports.
 */

import { splitCodeSegments } from '../code-mask.ts';
import { CLOSE_FG, ESC } from './resolve-color.ts';

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
 *
 * **Content is line-bounded (`[^\n]*?`, not `[\s\S]*?`).** Color tags
 * are inline-only (see the system-prompt addendum: emphasis on
 * individual words / short phrases, never whole paragraphs), so a
 * correct span never contains a newline. Bounding the content to a
 * single line makes a dropped `[/c]` fail LOCALLY - the orphaned open
 * stays a visible literal `[c:NAME]` on its own line - instead of
 * scanning forward and stealing a LATER line's `[/c]`, which would
 * paint everything in between (table rows, prose) as one runaway
 * colored span. That cross-line bleed was the original bug this bound
 * fixes.
 */
const CLOSED_TAG = /\[c:([^\]\s][^\]]*)\]([^\n]*?)\[\/c\]/g;

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
 *
 * Content is line-bounded (`[^\n]*`) for the same reason as
 * `CLOSED_TAG`: an unclosed trailing open colors to the end of its
 * own line, not across a newline into following rows. The lookahead
 * `(?!.*\[\/c\])` is already line-local (`.` doesn't cross `\n`), so
 * this only makes the existing line-local intent explicit.
 */
const OPEN_TAIL = /\[c:([^\]\s][^\]]*)\](?!.*\[\/c\])([^\n]*)$/;

/**
 * Match a literal close tag `[/c]` anywhere in the string. Pass 3
 * uses this to clean up orphans left behind by pass 2's destructive
 * rewrite (see the four-pass description in the module header).
 */
const LITERAL_CLOSE = /\[\/c\]/g;

/**
 * `ESC` (control-sequence introducer byte) and `CLOSE_FG` (foreground-only
 * reset) are shared with `resolve-color.ts` so the open/close pairs this
 * rewriter emits match the resolver's exactly. Defined as constants (not a
 * literal `\x1b` in a regex) so oxlint's `no-control-regex` stays happy when
 * we build `SGR_SEQ` via `new RegExp`.
 *
 * Match a single ANSI SGR sequence (`\x1b[…m`), capturing the numeric
 * parameter string. Used by `closeDanglingColorsAtLineEnds` to track
 * whether a foreground color is active at each line boundary.
 */
const SGR_SEQ = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');

/**
 * Given the SGR parameter string of one sequence (e.g. `38;2;95;135;255`
 * or `39`) and the foreground-active state before it, return the state
 * after it. Only foreground-affecting codes flip the state:
 *   - `30`-`37` / `90`-`97`, and extended `38;5;N` / `38;2;R;G;B` → active
 *   - `39` (default fg) and `0` / `` (full reset) → inactive
 *   - every other code (bold, italic, bg, …) leaves it unchanged
 * The `38;5;` / `38;2;` parameters are skipped so their numeric
 * arguments (which can look like `31`, `5`, `2`) are not misread as
 * standalone foreground codes.
 */
function fgActiveAfter(params: string, prev: boolean): boolean {
  const parts = params.split(';');
  let active = prev;
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (n === 38 || n === 48) {
      // Extended fg (38) / bg (48). Consume and skip the mode + its
      // arguments so they aren't reparsed as foreground codes.
      const isFg = n === 38;
      const mode = Number(parts[i + 1]);
      if (mode === 5) {
        if (isFg) active = true;
        i += 2;
      } else if (mode === 2) {
        if (isFg) active = true;
        i += 4;
      }
      continue;
    }
    // `Number('')` is 0, so a bare `\x1b[m` (full reset) clears fg too.
    if (n === 0 || n === 39) {
      active = false;
    } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
      active = true;
    }
  }
  return active;
}

/**
 * Streaming safety net: ensure no foreground color survives across a
 * newline. Color tags are inline-only, so a correct span always closes
 * on its own line. But the streaming OPEN_TAIL pass (pass 2) bakes an
 * open into the accumulated text whenever the colored run is the
 * trailing token of a chunk - and if the model later turns out to have
 * dropped the `[/c]`, that baked-in open has no close and bleeds its
 * color down through every following line until the next open re-colors
 * (the table-row bleed bug). Passes 1-3 work on bracket tags, not ANSI,
 * so they can't undo it.
 *
 * This pass walks each COMPLETED line (every line except the last,
 * still-being-typed one) and appends `CLOSE_FG` when that line ends with
 * an active foreground - terminating the dangling color at the line
 * boundary instead of letting it leak. It is idempotent: a line we
 * already closed ends inactive, so a re-run on the accumulated text adds
 * nothing. The trailing line is left untouched so live "color as you
 * type" keeps working for a span the model is still writing.
 */
function closeDanglingColorsAtLineEnds(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line.includes(ESC)) continue;
    let active = false;
    SGR_SEQ.lastIndex = 0;
    let m: RegExpExecArray | null = SGR_SEQ.exec(line);
    while (m !== null) {
      active = fgActiveAfter(m[1], active);
      m = SGR_SEQ.exec(line);
    }
    if (active) lines[i] = `${line}${CLOSE_FG}`;
  }
  return lines.join('\n');
}

/**
 * Match a single color OPEN marker `[c:NAME]` (no close). Group 1 is
 * the name. Used by `recoverOrphanOpens` to LOCATE bare opens left in
 * the text after pass 1 consumed every well-formed `[c:NAME]...[/c]`
 * pair on a line - not for pairing.
 */
const OPEN_MARKER = /\[c:([^\]\s][^\]]*)\]/g;

/**
 * Recovery for an unknown-color CLOSED pair `[c:NAME]content[/c]`
 * (pass 1, resolver miss). Small models routinely emit a bogus color
 * name, so rather than leave the broken tag literally on screen we
 * unwrap it:
 *   - non-empty content -> the content (`[c:special]hi[/c]` -> `hi`).
 *   - empty content -> the NAME itself, because the model put the
 *     word it meant to colour in the NAME slot (`[c:special][/c]` ->
 *     `special`). This matches the observed small-model failure where
 *     `[c:special]` *is* the content, not a colour directive.
 */
function recoverUnknownPair(rawName: string, content: string): string {
  return content.length > 0 ? content : rawName.trim();
}

/**
 * Recovery for unknown-color OPEN markers that pass 1 could not pair
 * with a `[/c]` (open with a dropped close, or `[c:special]` standing
 * alone). After pass 1 every well-formed pair on a line is gone, so any
 * surviving `[c:NAME]` is an orphan open. We unwrap it ONLY when NAME
 * does not resolve to a real colour:
 *   - content follows the marker on its line  -> drop just the marker,
 *     keep the content (`[c:special]hi` -> `hi`). Stable under the
 *     streaming `text += delta` accumulation: dropping a prefix leaves
 *     the content for later deltas to append to.
 *   - marker sits at its line end (no content) -> surface the NAME
 *     (`[c:special]` -> `special`), same reasoning as the empty pair.
 *
 * A RESOLVED open with a dropped close is deliberately left literal: a
 * real colour name with a missing `[/c]` is a recoverable model slip we
 * keep VISIBLE (the existing dropped-close contract), not a syntax
 * misuse to paper over.
 *
 * Streaming guard: on the still-being-typed LAST line we leave an
 * empty-at-line-end orphan literal, because the model may yet type the
 * span's content or its close. Unwrapping to the NAME there would bake
 * it into the accumulated text (`text += delta`) and glue it to
 * whatever streams next. Completed lines carry no such risk, and a
 * content-bearing orphan is safe to unwrap anywhere.
 */
function recoverOrphanOpens(text: string, resolver: ColorResolver, streaming: boolean): string {
  if (!text.includes('[c:')) return text;
  const lines = text.split('\n');
  const lastIdx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('[c:')) continue;
    const guardLineEnd = streaming && i === lastIdx;
    lines[i] = line.replace(OPEN_MARKER, (match: string, rawName: string, offset: number) => {
      // Valid colour: leave literal (dropped-close stays a visible slip).
      if (resolver(rawName)) return match;
      const atLineEnd = offset + match.length === line.length;
      if (atLineEnd) {
        if (guardLineEnd) return match; // still typing - don't bake the name in
        return rawName.trim();
      }
      return ''; // content follows: drop the marker, keep the content
    });
  }
  return lines.join('\n');
}

/**
 * Run every rewrite pass on a CODE-FREE fragment. Callers must hand
 * `rewritePlain` only prose runs (see `rewriteColorTags`'s segmentation)
 * so a regex match can never straddle a code boundary. `streaming`
 * carries the same meaning as `RewriteOptions.streaming`, but applies
 * only to the run that holds the live tail of the message.
 */
function rewritePlain(input: string, resolver: ColorResolver, streaming: boolean): string {
  // Pass 1: fully-closed pairs. Non-greedy, so we only consume as far
  // as the first `[/c]`. When the name resolves we wrap with ANSI; when
  // it does NOT we UNWRAP rather than leave the broken tag visible -
  // see `recoverUnknownPair` for why and how.
  let out = input.replace(CLOSED_TAG, (match, rawName: string, content: string) => {
    const resolved = resolver(rawName);
    if (!resolved) return recoverUnknownPair(rawName, content);
    return `${resolved.open}${content}${resolved.close}`;
  });

  // Recovery pass: unwrap any unknown-color OPEN that pass 1 could not
  // pair with a close (`[c:special]still here`, `[c:special]` at a line
  // end). Runs in both modes so finalised text is cleaned too; the
  // streaming flag only gates the still-typing-last-line guard inside.
  out = recoverOrphanOpens(out, resolver, streaming);

  if (!streaming) return out;

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

  // Pass 4 (streaming only): close any foreground color still active at
  // the end of a COMPLETED line. Pass 2 bakes an open into the
  // accumulated text whenever a colored run is the trailing token of a
  // chunk; once the model streams past that line without ever emitting
  // the `[/c]`, the baked-in open has no close and its color leaks down
  // through the following lines (the table-row bleed). Terminating the
  // color at the line boundary contains it to the one line the model
  // actually broke. Idempotent and leaves the still-typing last line
  // alone - see `closeDanglingColorsAtLineEnds`.
  out = closeDanglingColorsAtLineEnds(out);

  return out;
}

/**
 * Rewrite color tags in `input`. The result is a new string; `input`
 * is not mutated.
 *
 * `input` is first sliced into Markdown code / prose runs
 * (`splitCodeSegments`): code runs (fenced blocks, inline spans) are
 * reproduced verbatim - their `[c:NAME]` are literals the user wants
 * shown - and only prose runs go through `rewritePlain`. Slicing keeps
 * a regex match from pairing an open inside code with a close outside
 * it. The streaming tail applies only to the final run; earlier prose
 * runs are bounded by a following code run and so are already complete.
 */
export function rewriteColorTags(input: string, resolver: ColorResolver, options: RewriteOptions = {}): string {
  if (input.length === 0) return input;

  const segments = splitCodeSegments(input);
  const streaming = options.streaming === true;

  // Fast path: no code regions -> one prose run, behaves exactly as the
  // pre-segmentation rewriter did.
  if (segments.length === 1 && !segments[0].code) {
    return rewritePlain(input, resolver, streaming);
  }

  const lastIdx = segments.length - 1;
  let result = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.code) {
      result += seg.text; // verbatim: code is a literal
      continue;
    }
    // Only the final prose run can hold the live, still-typing tail.
    result += rewritePlain(seg.text, resolver, streaming && i === lastIdx);
  }
  return result;
}
