/**
 * Pure helpers for the memory extension's "capture-assist" nudge.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * ## What the extension does (Depth A timing nudge + Depth B-lite candidates)
 *
 * Pi fires `session_before_compact` when it is about to summarize the
 * conversation away - the moment any durable fact that surfaced
 * mid-session (a preference, a correction, a project decision, an
 * external pointer) is at risk of being lost if it was never `memory
 * save`d. That event can only cancel/replace the compaction, not inject
 * context, so the extension ARMS a one-shot flag there and the next
 * `context` hook splices a SHORT reminder into the turn as a
 * `<system-reminder>` - reaching the model itself, not just the UI.
 *
 * Depth A is purely a TIMING prompt ({@link CAPTURE_NUDGE}) - the model
 * already carries the `memory-first` skill describing *what* to save. An
 * eval showed a generic timing nudge converts to zero saves on a small
 * model, so Depth B-lite makes the nudge CONCRETE: it reuses the
 * compaction summary (already paid for - no extra model call), which
 * emits `## Constraints & Preferences` and `## Key Decisions` sections,
 * to extract candidate durable facts ({@link extractCandidatesFromSummary}),
 * drops any already covered by a saved memory
 * ({@link selectCaptureCandidates}), and lists the survivors in a
 * stronger nudge ({@link buildCandidateNudge}). When no candidate
 * survives, the extension falls back to the generic {@link CAPTURE_NUDGE}.
 *
 * ## Nag-fatigue gating
 *
 * A reminder on *every* compaction would be noise. The predicate below
 * suppresses the nudge unless there is plausibly something unsaved to
 * capture: there must have been at least one user turn since the last
 * successful `memory save` this session. A fresh save resets the
 * counter, so back-to-back compactions with no intervening user
 * activity stay quiet. The nudge is also suppressed entirely when
 * memory can't be written (read-only) or the feature is disabled.
 */

/**
 * Closure-state snapshot the extension feeds to {@link shouldNudgeCapture}.
 * The extension tracks `userTurnsSinceLastSave` by incrementing on each
 * user submit and resetting to `0` on every successful `memory save`.
 */
export interface CaptureNudgeState {
  /**
   * User turns (submits) observed since the last successful save this
   * session. `0` means either nothing has happened yet or the most
   * recent action was a save - in both cases there is nothing fresh to
   * capture, so we stay quiet.
   */
  userTurnsSinceLastSave: number;
  /** `PI_MEMORY_READONLY=1` - saves are blocked, so a nudge is pointless. */
  readOnly: boolean;
  /** `PI_MEMORY_DISABLE_CAPTURE=1` - the capture-assist nudge is turned off. */
  disabled: boolean;
}

/**
 * The one-shot reminder spliced into the turn after a compaction.
 * Deliberately short (a timing nudge, not policy) and stable so tests can
 * pin it. Mentions the concrete durable categories so the model knows what
 * "worth keeping" means without re-reading the whole skill.
 */
export const CAPTURE_NUDGE =
  'The conversation was just compacted, which can drop earlier detail. ' +
  'If anything durable surfaced this session (a user preference, a correction, ' +
  'a project decision, an external pointer) that you have not `memory save`d yet, ' +
  'recall and save it now so it survives.';

/**
 * Decide whether to surface the capture-assist nudge before compaction.
 *
 * Nudge only when ALL hold:
 *   - capture-assist is enabled (`!disabled`), and
 *   - memory is writable (`!readOnly`), and
 *   - there has been at least one user turn since the last save
 *     (`userTurnsSinceLastSave > 0`) - i.e. there is plausibly
 *     something unsaved to capture.
 *
 * Otherwise stay quiet. Pure + deterministic so the extension's only
 * job is to keep `userTurnsSinceLastSave` accurate.
 */
export function shouldNudgeCapture(state: CaptureNudgeState): boolean {
  if (state.disabled) return false;
  if (state.readOnly) return false;
  return state.userTurnsSinceLastSave > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Depth B-lite: concrete candidates from the compaction summary
// ──────────────────────────────────────────────────────────────────────

/**
 * A durable fact pulled from the compaction summary that does not look
 * saved yet, ready to be listed in {@link buildCandidateNudge}.
 */
export interface CaptureCandidate {
  /** The bullet text, stripped of markers / checkbox / bold and trimmed. */
  text: string;
  /** Which summary section it came from (drives ordering only). */
  section: 'preferences' | 'decisions';
}

/** Most candidates we ever list, so the nudge stays short and scannable. */
const MAX_CANDIDATES = 5;

/**
 * Section headers (case-insensitive) the summarizer's `SUMMARIZATION_PROMPT`
 * emits whose bullets are durable-fact candidates. A section's bullets run
 * until the next `## ` header or end of string.
 */
const SECTION_HEADERS: readonly { header: string; section: CaptureCandidate['section'] }[] = [
  { header: 'constraints & preferences', section: 'preferences' },
  { header: 'key decisions', section: 'decisions' },
];

/**
 * Placeholder bullet texts the summarizer emits when a section has no real
 * content. Compared case-insensitively after stripping surrounding
 * punctuation/whitespace (see {@link isPlaceholder}).
 */
const PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set(['none', 'none were mentioned', 'not applicable', 'n/a']);

/** Normalize for dedup: lowercased, whitespace-collapsed, trimmed. */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Strip a leading list marker (`-`/`*`), an optional `[x]`/`[ ]` checkbox,
 * and a single layer of surrounding `**bold**`; then trim.
 */
function stripBulletDecoration(line: string): string {
  let text = line.trim().replace(/^[-*]\s+/, '');
  text = text.replace(/^\[[ xX]\]\s*/, '');
  text = text.trim();
  const bold = /^\*\*(.*)\*\*$/.exec(text);
  if (bold) text = bold[1].trim();
  return text.trim();
}

/**
 * True for empty / `(none)` / template-leftover bullets that should never
 * be proposed. Template leftovers are the literal `[ ... ]` instructions
 * the prompt template carries (e.g. `[Any constraints, preferences...]`,
 * `[Decision]: [rationale]`).
 */
function isPlaceholder(text: string): boolean {
  if (text.length === 0) return true;
  // Strip surrounding parens/punctuation/whitespace for the (none) family.
  const bare = text.replace(/^[\s().,:;-]+|[\s().,:;-]+$/g, '').toLowerCase();
  if (PLACEHOLDER_TEXTS.has(bare)) return true;
  // Obvious template leftover: a single bracketed instruction.
  if (text.startsWith('[') && text.endsWith(']')) return true;
  return false;
}

/**
 * Parse a compaction summary (the `SUMMARIZATION_PROMPT` markdown format)
 * for save-worthy bullets. Collects `- `/`* ` bullets under
 * `## Constraints & Preferences` (→ `preferences`) and `## Key Decisions`
 * (→ `decisions`), stopping each section at the next `## ` header. Strips
 * markers / checkbox / bold, drops placeholders and template leftovers,
 * dedups on normalized text, and caps the result to {@link MAX_CANDIDATES}
 * (preferences first, then decisions, preserving order).
 */
export function extractCandidatesFromSummary(summary: string): CaptureCandidate[] {
  const lines = summary.split('\n');
  let active: CaptureCandidate['section'] | null = null;
  const preferences: CaptureCandidate[] = [];
  const decisions: CaptureCandidate[] = [];

  for (const raw of lines) {
    const headerMatch = /^##\s+(.*?)\s*$/.exec(raw);
    if (headerMatch) {
      const title = headerMatch[1].toLowerCase().trim();
      active = SECTION_HEADERS.find((h) => h.header === title)?.section ?? null;
      continue;
    }
    if (!active) continue;
    if (!/^\s*[-*]\s+/.test(raw)) continue;
    const text = stripBulletDecoration(raw);
    if (isPlaceholder(text)) continue;
    (active === 'preferences' ? preferences : decisions).push({ text, section: active });
  }

  const seen = new Set<string>();
  const out: CaptureCandidate[] = [];
  for (const candidate of [...preferences, ...decisions]) {
    const key = normalizeForDedup(candidate.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Candidates from {@link extractCandidatesFromSummary} minus any already
 * covered by a saved memory. `isAlreadySaved` is injected so this stays
 * pure (the extension wires it to `findSimilarMemories` over current state).
 */
export function selectCaptureCandidates(
  summary: string,
  isAlreadySaved: (text: string) => boolean,
): CaptureCandidate[] {
  return extractCandidatesFromSummary(summary).filter((c) => !isAlreadySaved(c.text));
}

/**
 * Build the stronger, concrete capture nudge. Returns `null` when there
 * are no candidates so the caller falls back to the generic
 * {@link CAPTURE_NUDGE}. Otherwise lists each candidate's text as a bullet
 * and instructs the model to `memory save` the keepers (with the right
 * type/scope) and ignore the rest.
 */
export function buildCandidateNudge(candidates: CaptureCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const lead =
    'The conversation was just compacted. These durable facts surfaced this session and do not look saved yet:';
  const bullets = candidates.map((c) => `- ${c.text}`).join('\n');
  const close =
    'If any are worth keeping across sessions, `memory save` them now with the right type/scope; ignore the rest.';
  return `${lead}\n${bullets}\n${close}`;
}
