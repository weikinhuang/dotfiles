/**
 * Rolling in-context window reduction for the `roleplay` extension.
 *
 * Pure, pi-free, unit-testable logic consolidated from the experimental
 * `rp-context-window.ts` probe (rp-test repo). The `roleplay` extension
 * calls into these helpers from its `context` hook every turn to keep a
 * small-window model (e.g. gemma4-31b at 57k with a ~35k system prompt,
 * leaving ~22k usable) bounded without paying for pi's see-sawing
 * threshold compaction.
 *
 * Three cooperating zones, oldest -> newest, produced by
 * {@link applyLayeredWindow} once a recap covers the aged prefix:
 *
 *   [0, dropCutoff)              DROPPED entirely - their content lives
 *                                in the recap (bounded, O(1) in scene length).
 *   [dropCutoff, condenseCutoff) condensed head+tail (recap does not yet
 *                                cover them; a failed recap degrades to "keep").
 *   [condenseCutoff, end)        kept verbatim (the recent scene).
 *
 * Both cutoffs land on user-message boundaries ({@link computeCutoff}
 * guarantees this) so dropping never orphans a tool result from its call
 * or breaks role alternation.
 *
 * The output is a NON-DESTRUCTIVE ephemeral overlay: pi's `context` hook
 * output is never persisted, so the full prose stays in the session
 * `.jsonl` and the user still scrolls back through everything. Nothing is
 * deleted; the model is just sent less.
 *
 * No pi imports.
 */

/** A message is an opaque record; only `role` and `content` are read here. */
type Msg = Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────
// Window options + deterministic condensation
// ──────────────────────────────────────────────────────────────────────

export interface WindowOptions {
  /** Most-recent user-turns kept fully verbatim (everything after them too). */
  keepTurns: number;
  /** Char budget for the text of older assistant messages. */
  assistantChars: number;
  /** Char budget for the text of older user messages. */
  userChars: number;
}

export const DEFAULT_WINDOW_OPTIONS: WindowOptions = {
  keepTurns: 8,
  assistantChars: 200,
  userChars: 400,
};

/**
 * Fraction of a condense budget spent on the HEAD of a message; the rest
 * goes to the TAIL. RP "oh, before I forget ..." facts cluster at the END
 * of a message, so head-only truncation drops them (measured in the field:
 * a buried-tail key fact was lost while the head survived). Keeping a tail
 * slice recovers them.
 */
export const HEAD_FRACTION = 0.6;

/**
 * Truncate to `budget` chars keeping BOTH the head and the tail of the
 * text, with a count marker between. Returns `null` if no change (or if
 * condensing would not actually shorten).
 */
export function truncateText(text: string, budget: number): string | null {
  if (text.length <= budget) return null;

  const headBudget = Math.max(1, Math.round(budget * HEAD_FRACTION));
  const tailBudget = Math.max(1, budget - headBudget);

  // Head: cut back to a word boundary if one is reasonably near the end.
  let head = text.slice(0, headBudget);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > headBudget * 0.6) head = head.slice(0, lastSpace);
  head = head.replace(/\s+$/, '');

  // Tail: start at a word boundary so we don't begin mid-word.
  let tail = text.slice(text.length - tailBudget);
  const firstSpace = tail.indexOf(' ');
  if (firstSpace >= 0 && firstSpace < tailBudget * 0.4) tail = tail.slice(firstSpace + 1);
  tail = tail.replace(/^\s+/, '');

  const trimmed = text.length - head.length - tail.length;
  // Not worth it if the head and tail already (nearly) cover the text.
  if (trimmed <= 0) return null;
  const condensed = `${head} […+${trimmed} chars trimmed…] ${tail}`;
  return condensed.length < text.length ? condensed : null;
}

/** Condense the text content of one message to `budget`. Returns null if nothing changed. */
export function condenseMessage(msg: Msg, budget: number): Msg | null {
  if (budget <= 0) return null;
  const content = msg.content;

  if (typeof content === 'string') {
    const t = truncateText(content, budget);
    return t === null ? null : { ...msg, content: t };
  }

  if (Array.isArray(content)) {
    let changed = false;
    const out: unknown[] = [];
    for (const part of content) {
      const p = part as Msg;
      if (p.type === 'text' && typeof p.text === 'string') {
        const t = truncateText(p.text, budget);
        if (t !== null) {
          changed = true;
          out.push({ ...p, text: t });
          continue;
        }
      }
      out.push(part);
    }
    return changed ? { ...msg, content: out } : null;
  }

  return null;
}

/**
 * Index of the first message that belongs to the kept verbatim window
 * (start of the K-th user-turn from the end). Everything before it is
 * "old". Returns 0 when there is not yet enough history to have anything
 * old. Because the boundary is always a user message, dropping / condensing
 * everything before it never orphans a tool result from its call.
 */
export function computeCutoff(messages: readonly Msg[], keepTurns: number): number {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIdx.push(i);
  });
  if (userIdx.length <= keepTurns) return 0;
  return userIdx[userIdx.length - keepTurns];
}

/** Per-role condense budget for a message (0 = leave untouched). */
function budgetFor(role: unknown, opts: WindowOptions): number {
  if (role === 'assistant') return opts.assistantChars;
  if (role === 'user') return opts.userChars;
  return 0;
}

/**
 * Condense the text of `messages[0..cutoff)` to the per-role budget, leave
 * `messages[cutoff..]` verbatim. Used with a FROZEN cutoff so the rewritten
 * prefix is byte-identical turn to turn (preserving the model's
 * prompt-prefix cache) between rolls. This is the `summarize off` floor:
 * it KEEPS every message (condensed), so it is not size-bounded.
 */
export function applyContextWindowAt(
  messages: readonly Msg[],
  cutoff: number,
  opts: WindowOptions,
): { messages: readonly Msg[]; condensed: number } {
  if (cutoff <= 0) return { messages, condensed: 0 };

  let condensed = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m;
    const rewritten = condenseMessage(m, budgetFor(m.role, opts));
    if (rewritten) {
      condensed += 1;
      return rewritten;
    }
    return m;
  });

  return { messages: condensed > 0 ? out : messages, condensed };
}

/**
 * Layered window for the recap-backed (bounded) mode. Unlike
 * {@link applyContextWindowAt} this makes total size O(1) in conversation
 * length: the recap-covered prefix `[0, dropCutoff)` is REMOVED, not just
 * shortened; `[dropCutoff, condenseCutoff)` is condensed head+tail; the rest
 * is verbatim. Both cutoffs must land on user-message boundaries
 * (computeCutoff guarantees this).
 */
export function applyLayeredWindow(
  messages: readonly Msg[],
  dropCutoff: number,
  condenseCutoff: number,
  opts: WindowOptions,
): { messages: readonly Msg[]; dropped: number; condensed: number } {
  const drop = Math.max(0, Math.min(dropCutoff, messages.length));
  const condense = Math.max(drop, Math.min(condenseCutoff, messages.length));
  if (drop === 0 && condense === 0) return { messages, dropped: 0, condensed: 0 };
  let condensed = 0;
  const out: Msg[] = [];
  for (let i = drop; i < messages.length; i++) {
    const m = messages[i];
    if (i < condense) {
      const rewritten = condenseMessage(m, budgetFor(m.role, opts));
      if (rewritten) {
        condensed += 1;
        out.push(rewritten);
        continue;
      }
    }
    out.push(m);
  }
  return { messages: out, dropped: drop, condensed };
}

// ──────────────────────────────────────────────────────────────────────
// Recap acceptance + injection
// ──────────────────────────────────────────────────────────────────────

/**
 * Guard against a degenerate recap clobbering a good accumulated one. The
 * summarizer merges cumulatively, so a fresh recap should be comparable to
 * or longer than the prior; a sudden collapse (measured in the field:
 * 3456 -> 95 chars) is a bad generation that would erase load-bearing scene
 * memory now that the recap is the ONLY in-context record of dropped turns.
 * Accept the candidate only when there is no prior, or it retains at least
 * `floorFraction` of the prior length.
 */
export function acceptRecap(prior: string, candidate: string | null, floorFraction = 0.5): boolean {
  if (!candidate?.trim()) return false;
  const prev = prior.trim().length;
  if (prev === 0) return true;
  return candidate.trim().length >= prev * floorFraction;
}

export const RECAP_PREFIX = '[Scene memory \u2014 established facts from earlier in this conversation, for continuity:';

export const TIMELINE_PREFIX = '[Recent timeline \u2014 dated story beats in chronological order, for continuity:';

/** Prepend a synthetic block to the first user message (keeps role alternation intact). */
function prependToFirstUser(messages: readonly Msg[], block: string): readonly Msg[] {
  let anchor = messages.findIndex((m) => m.role === 'user');
  if (anchor < 0) anchor = 0;
  if (anchor >= messages.length) return messages;
  const target = messages[anchor];
  const content = target.content;
  let newContent: unknown;
  if (typeof content === 'string') {
    newContent = block + content;
  } else if (Array.isArray(content)) {
    const arr = content as Msg[];
    const idx = arr.findIndex((p) => p.type === 'text');
    if (idx >= 0) {
      newContent = arr.map((part, i) => {
        if (i !== idx) return part;
        const text = typeof part.text === 'string' ? part.text : '';
        return { ...part, text: block + text };
      });
    } else {
      newContent = [{ type: 'text', text: block }, ...arr];
    }
  } else {
    newContent = block;
  }
  return messages.map((m, i) => (i === anchor ? { ...m, content: newContent } : m));
}

/**
 * Inject the cached recap as a prefix on the first user message (keeps role
 * alternation intact). Pure: returns a new array, or the same array if there
 * is no recap text or no user message to anchor on.
 */
export function injectRecap(messages: readonly Msg[], recapText: string): readonly Msg[] {
  const recap = recapText.trim();
  if (!recap) return messages;
  return prependToFirstUser(messages, `${RECAP_PREFIX}\n${recap}\n]\n\n`);
}

/**
 * Inject a pre-rendered timeline block (already trimmed / capped by the
 * caller via `renderTimelineBlock`) as a SEPARATE prefix on the first user
 * message, so it never competes with the recap or the hand-authored
 * `formatRoleplayBlock` for their char budgets. Pure; no-op on empty input.
 */
export function injectTimeline(messages: readonly Msg[], block: string): readonly Msg[] {
  const t = block.trim();
  if (!t) return messages;
  return prependToFirstUser(messages, `${TIMELINE_PREFIX}\n${t}\n]\n\n`);
}

/**
 * Decide whether to (re)compute the recap: fire once the aged-out span has
 * grown by at least `chunk` messages since the last recap / roll. `oldCount`
 * is the natural cutoff (aged-message count), `covered` is the frozen
 * boundary, `chunk` is the roll stride.
 */
export function planRecap(oldCount: number, covered: number, chunk: number): boolean {
  return oldCount > 0 && oldCount - covered >= chunk;
}

/**
 * Freeze the hard-safety floor between rolls so the drop boundary - and thus
 * the whole prompt prefix - stays byte-stable turn to turn and the provider's
 * prompt-prefix cache survives.
 *
 * The floor ({@link computeCutoff} over a window-fit turn count) creeps forward
 * a message or two EVERY turn as new turns arrive: the fit turn-count is
 * roughly constant, but its mapped user-boundary index grows with the
 * transcript. Recomputed raw every turn, it shifts the drop / recap-injection
 * anchor every turn, so the ~kept-window suffix falls out of cache and is
 * reprocessed (observed: ~12-13k tokens re-evaluated per turn). This makes the
 * floor obey the same freeze-between-rolls invariant `committedCutoff` /
 * `recapCutoff` already follow.
 *
 * - On a roll (`rollFired`) the whole prefix is re-cut anyway, so adopt the
 *   fresh `rawFloor`.
 * - `overflow` is the hard-safety valve: when HOLDING the frozen floor would
 *   actually exceed the window budget (the caller estimates this from the held
 *   suffix), advance to `rawFloor` even mid-cycle rather than send an
 *   over-window prompt. Rare, because the per-turn reserve absorbs a roll's
 *   worth of growth.
 * - Otherwise hold the frozen index. Never regress (a smaller cut would only
 *   re-admit already-dropped messages and bust cache for no benefit).
 */
export function freezeFloorCutoff(opts: {
  frozen: number;
  rawFloor: number;
  rollFired: boolean;
  overflow: boolean;
}): number {
  const { frozen, rawFloor, rollFired, overflow } = opts;
  if (rollFired) return rawFloor;
  if (overflow) return Math.max(frozen, rawFloor);
  return frozen;
}

/**
 * Bound how far a single roll advances recap coverage. The roll summarizes
 * `messages[recapCutoff, spanTo)` and, on success, moves `recapCutoff` to
 * `spanTo`. Left unbounded (`spanTo = natural`) a stalled recap re-attempts an
 * ever-growing span: the summarizer is asked to re-merge hundreds of messages
 * into the running recap, collapses to a fraction of the prior, {@link
 * acceptRecap} rejects it, coverage never advances, the span grows further -
 * a self-reinforcing wedge (observed: recapCutoff pinned 190 turns). It also
 * silently loses content, because {@link planSummarization} truncates the span
 * TEXT to a char cap while coverage still advances over the whole span.
 *
 * Capping the advance keeps every roll an incremental append of a digestible
 * chunk onto the prior recap - which the summarizer handles without collapsing
 * and which never exceeds the summarizer's span-text cap - so coverage drains
 * a bounded step per roll and `acceptRecap` passes naturally. `maxAdvance <= 0`
 * disables the cap (legacy `spanTo = natural`).
 */
export function boundRollSpanTo(recapCutoff: number, natural: number, maxAdvance: number): number {
  if (maxAdvance <= 0) return natural;
  return Math.min(natural, recapCutoff + maxAdvance);
}

/**
 * Circuit-breaker guaranteeing recap coverage can never wedge permanently.
 * {@link acceptRecap} rejects a candidate that collapses below the prior; that
 * guard protects against a one-off bad generation, but with {@link
 * boundRollSpanTo} disabled or a persistently degrading summarizer it can still
 * stall coverage indefinitely. When the uncovered lag `natural - recapCutoff`
 * grows past `lagCeiling`, accept the best non-empty candidate anyway: a
 * one-time recap shrink that restores forward progress beats permanent
 * staleness plus the safety floor silently dropping the uncovered span. Returns
 * false when there is nothing usable to accept or the lag is still tolerable.
 * `lagCeiling <= 0` disables the breaker.
 */
export function shouldForceRecap(opts: { candidate: string | null; lag: number; lagCeiling: number }): boolean {
  const { candidate, lag, lagCeiling } = opts;
  if (lagCeiling <= 0) return false;
  if (!candidate?.trim()) return false;
  return lag >= lagCeiling;
}

// ──────────────────────────────────────────────────────────────────────
// Token estimation + budget derivation (measure-first sizing)
// ──────────────────────────────────────────────────────────────────────

/**
 * Rough char count for a message list, summing text/thinking/tool payloads
 * and charging a flat cost per image part. For the DEBUG composition audit
 * and budget math only - never a routing decision on its own.
 */
export function estimateChars(messages: readonly Msg[]): number {
  let n = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      n += c.length;
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      const p = part as Msg;
      if (typeof p.text === 'string') n += p.text.length;
      else if (typeof p.thinking === 'string') n += p.thinking.length;
      else if (p.type === 'toolCall') n += JSON.stringify(p.arguments ?? {}).length + 24;
      else if (p.type === 'toolResult') n += JSON.stringify(p.content ?? '').length;
      else if (p.type === 'image') n += 4000; // ~1k tokens, flat
    }
  }
  return n;
}

/** Fallback chars-per-token when nothing is calibrated yet (crude chars/4). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Blend the crude chars/token estimate toward the ratio implied by a real
 * turn's reported usage. `estimatedChars` is what {@link estimateChars} said
 * the prompt was; `actualTokens` is the provider-reported prompt token count
 * (pi's `usage` - ground truth). Returns an EMA-smoothed chars-per-token so
 * the budget math is measured, not guessed. Ignores nonsense inputs and
 * returns `prior` unchanged.
 */
export function updateCharsPerToken(prior: number, estimatedChars: number, actualTokens: number, alpha = 0.3): number {
  if (!Number.isFinite(estimatedChars) || !Number.isFinite(actualTokens)) return prior;
  if (estimatedChars <= 0 || actualTokens <= 0) return prior;
  const observed = estimatedChars / actualTokens;
  // Guard against absurd ratios (e.g. a mostly-image turn) skewing the model.
  if (observed < 1 || observed > 20) return prior;
  const base = Number.isFinite(prior) && prior > 0 ? prior : DEFAULT_CHARS_PER_TOKEN;
  return base * (1 - alpha) + observed * alpha;
}

export interface DeriveMaxSpanCharsOptions {
  /** The recap model's full context window, in tokens. */
  contextWindowTokens?: number;
  /** Length of the prior running recap fed back into the summarizer, in chars. */
  priorRecapChars?: number;
  /** Tokens reserved for the recap output. */
  outputReserveTokens?: number;
  /** Fixed prompt overhead (agent system prompt + task scaffold), in tokens. */
  overheadTokens?: number;
  /** Calibrated chars-per-token; defaults to the crude chars/4. */
  charsPerToken?: number;
  /** Floor so a tiny/odd window can never blank the span. */
  minChars?: number;
  /** Value used when the window is unknown / invalid (matches summarize.ts's historic 8000). */
  fallbackChars?: number;
}

/** Floor on a derived span cap so a small recap model can't blank the input. */
export const MIN_SPAN_CHARS = 2000;

/**
 * Derive the maximum span (in chars) that can be fed to the recap
 * summarizer without silently dropping its oldest half. Replaces the
 * hardcoded 8000-char cap: with a large recap model window the span cap
 * scales up so a big `chunk` is summarized losslessly; with an unknown
 * window it falls back to the historic 8000 so behavior is unchanged.
 */
export function deriveMaxSpanChars(opts: DeriveMaxSpanCharsOptions): number {
  const {
    contextWindowTokens,
    priorRecapChars = 0,
    outputReserveTokens = 512,
    overheadTokens = 512,
    charsPerToken = DEFAULT_CHARS_PER_TOKEN,
    minChars = MIN_SPAN_CHARS,
    fallbackChars = 8000,
  } = opts;

  if (typeof contextWindowTokens !== 'number' || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return fallbackChars;
  }
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const availTokens = contextWindowTokens - outputReserveTokens - overheadTokens;
  const availChars = availTokens * cpt - Math.max(0, priorRecapChars);
  if (!Number.isFinite(availChars)) return fallbackChars;
  return Math.max(minChars, Math.floor(availChars));
}

/**
 * Walk backward from the newest message, counting whole user-turns whose
 * estimated token cost fits within `budgetTokens`, and return how many
 * user-turns to keep verbatim. Adaptive to prose verbosity: a wall of long
 * turns keeps fewer, terse turns keep more. Clamped to
 * `[minTurns, maxTurns]`. The caller quantizes application to roll
 * boundaries (cache stability); this helper only computes the target count.
 */
export function deriveKeepTurns(
  messages: readonly Msg[],
  budgetTokens: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
  minTurns = 2,
  maxTurns = 64,
): number {
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const budgetChars = Math.max(0, budgetTokens) * cpt;
  let usedChars = 0;
  let turns = 0;
  // Accumulate messages newest-first; each user message starts a new turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateChars([messages[i]]);
    if (usedChars + cost > budgetChars && turns >= minTurns) break;
    usedChars += cost;
    if (messages[i].role === 'user') {
      turns += 1;
      if (turns >= maxTurns) break;
    }
  }
  return Math.max(minTurns, Math.min(maxTurns, turns));
}
