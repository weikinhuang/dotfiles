/**
 * Pure logic for the agent-callable drop / collapse tools (`drop_image`
 * in `context-trim.ts`, `collapse_output` in `tool-collapse.ts`). See
 * `plans/pi-agentic-context-edit-tools.md`.
 *
 * No pi imports - testable under `vitest` without the runtime. The
 * pi-coupled glue (the confirmation dialog, the interactive multi-select,
 * the actual `addTrim` / `addCollapse` calls) lives in the two extension
 * shells; this module owns only the pure pieces:
 *
 *   - recency-ordinal target resolution: turn a `{ drop?, keepRecent? }`
 *     selector into a concrete set of candidates, addressed by recency
 *     among the matching candidates (most-recent = ordinal 1),
 *   - the tail-guard: refuse to drop the most-recent N matching
 *     candidates so the model can't shed the content it is actively
 *     working with (large N forces cache-hostile long-suffix drops -
 *     see the umbrella's cache note),
 *   - a drop-specific {@link DropDecision} union + confirmation-dialog
 *     `entries` builder (consumed by the shared
 *     {@link promptSelectWithFeedback} engine, exactly like
 *     `bash-permissions`), and
 *   - the resolved-items dialog title so the human verifies targeting
 *     before anything drops.
 */

import { DENY_WITH_FEEDBACK, type PromptEntry } from '../approval-prompt.ts';
import { type Candidate, candidateLabel } from './enumerate.ts';
import { trimOrUndefined } from '../shared/strings.ts';

/** Default tail-guard: never drop the single most-recent matching candidate. */
export const DEFAULT_TAIL_GUARD = 1;

/**
 * Recency-ordinal selector shared by both tools. Ordinals are 1-based
 * among the *matching* candidates, most-recent first (`1` = the newest
 * image / tool pair in context).
 *
 *   - `drop: [2]`       - pointed: drop the 2nd-most-recent candidate.
 *   - `keepRecent: 3`   - batch / lump-sum: drop everything BEYOND the
 *                         most recent 3 (ordinals 4, 5, …).
 *
 * Both may be combined; the selected sets union.
 */
export interface RecencySelector {
  drop?: number[];
  keepRecent?: number;
}

/** A candidate paired with its recency ordinal (1 = most-recent). */
export interface RankedCandidate {
  candidate: Candidate;
  /** 1-based recency ordinal among the matching candidates. */
  ordinal: number;
}

/**
 * Outcome of {@link resolveRecencyTargets}. `selected` is what will
 * actually drop (after the tail-guard); `guarded` matched the selector
 * but is protected by the tail-guard; `missing` are explicit `drop`
 * ordinals with no candidate.
 */
export interface DropResolution {
  /** To drop, most-recent first. Deduped by target. */
  selected: RankedCandidate[];
  /** Matched the selector but refused by the tail-guard, most-recent first. */
  guarded: RankedCandidate[];
  /** Explicit `drop` ordinals that addressed no candidate. */
  missing: number[];
  /** Total matching candidates available this turn. */
  total: number;
  /** The effective tail-guard applied. */
  tailGuard: number;
}

/**
 * Rank candidates newest-first by their enumerate `seq` (document order),
 * assigning 1-based recency ordinals. Falls back to the input order when
 * `seq` is absent so callers that hand-build candidates still get a
 * deterministic ranking.
 */
export function byRecency(candidates: readonly Candidate[]): RankedCandidate[] {
  const withIndex = candidates.map((candidate, i) => ({ candidate, i }));
  withIndex.sort((a, b) => {
    const sa = a.candidate.seq ?? a.i;
    const sb = b.candidate.seq ?? b.i;
    // Higher seq = more recent = lower ordinal.
    return sb - sa;
  });
  return withIndex.map(({ candidate }, idx) => ({ candidate, ordinal: idx + 1 }));
}

/** Stable identity for de-duping resolved candidates across `drop` + `keepRecent`. */
function candidateKey(c: Candidate): string {
  if (c.toolCallId) return `tc:${c.toolCallId}`;
  if (c.target?.by === 'toolCallId') return `tc:${c.target.toolCallId}`;
  if (c.target?.by === 'message') return `msg:${c.target.role}:${c.target.timestamp}:${c.target.occurrence ?? 0}`;
  return `id:${c.id}`;
}

/**
 * Resolve a {@link RecencySelector} against the matching candidates
 * (filtered + ordered by the caller into any order - we re-rank by
 * recency here) and split them into drop / guarded / missing.
 *
 * Tail-guard: ordinals `1 .. tailGuard` are protected. A `drop` ordinal
 * inside the guard lands in `guarded` (refused, surfaced to the model);
 * `keepRecent` is clamped up to the guard so a batch can never reach into
 * the protected tail.
 */
export function resolveRecencyTargets(
  candidates: readonly Candidate[],
  selector: RecencySelector,
  tailGuard: number = DEFAULT_TAIL_GUARD,
): DropResolution {
  const guard = Math.max(0, Math.floor(tailGuard));
  const ranked = byRecency(candidates);
  const total = ranked.length;
  const byOrdinal = new Map<number, RankedCandidate>();
  for (const r of ranked) byOrdinal.set(r.ordinal, r);

  const requested = new Set<number>();
  const missing: number[] = [];

  // Pointed form.
  for (const raw of selector.drop ?? []) {
    const ord = Math.floor(raw);
    if (!Number.isFinite(ord) || ord < 1 || ord > total) {
      missing.push(raw);
      continue;
    }
    requested.add(ord);
  }

  // Batch / lump-sum form: drop everything beyond the most-recent N. Clamp
  // keepRecent up to the guard so the batch never reaches the protected tail.
  if (selector.keepRecent !== undefined && Number.isFinite(selector.keepRecent)) {
    const keep = Math.max(guard, Math.max(0, Math.floor(selector.keepRecent)));
    for (let ord = keep + 1; ord <= total; ord++) requested.add(ord);
  }

  const selected: RankedCandidate[] = [];
  const guarded: RankedCandidate[] = [];
  const seenKeys = new Set<string>();
  for (const ord of [...requested].sort((a, b) => a - b)) {
    const hit = byOrdinal.get(ord);
    if (!hit) continue;
    const key = candidateKey(hit.candidate);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (ord <= guard) guarded.push(hit);
    else selected.push(hit);
  }

  return { selected, guarded, missing, total, tailGuard: guard };
}

// ──────────────────────────────────────────────────────────────────────
// Confirmation dialog: decision union + entries builder (mirrors
// `bash-permissions`; do NOT widen the shared `ApprovalDecision`).
// ──────────────────────────────────────────────────────────────────────

/**
 * Decision returned by the drop confirmation prompt. `never-session` and
 * `edit-selection` stay LOCAL to this union - adding them to the shared
 * `ApprovalDecision` would force a new `case` into `filesystem.ts`. The
 * caller handles `edit-selection` (open the multi-select) and
 * `never-session` (flip the session deny flag) verbatim, exactly as
 * `bash-permissions` handles its local `allow-project-*` variants.
 */
export type DropDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session' }
  | { kind: 'edit-selection' }
  | { kind: 'never-session' }
  | { kind: 'deny'; feedback?: string };

/**
 * Build the confirmation-dialog entries for the shared
 * {@link promptSelectWithFeedback} engine. `toolName` is echoed into the
 * session-scoped options so the dialog reads naturally for either tool.
 */
export function buildDropEntries(toolName: string): PromptEntry<DropDecision>[] {
  return [
    { label: 'Allow once', decision: { kind: 'allow-once' } },
    { label: `Allow ${toolName} for this session`, decision: { kind: 'allow-session' } },
    { label: 'Edit selection…', decision: { kind: 'edit-selection' } },
    { label: 'Deny', decision: { kind: 'deny' } },
    { label: 'Deny with feedback…', decision: DENY_WITH_FEEDBACK },
    { label: 'Never allow this session', decision: { kind: 'never-session' } },
  ];
}

/** A resolved item rendered into the dialog title: ordinal + label (+ optional description). */
export interface DropTitleItem {
  ordinal: number;
  /** Candidate label (size + snippet); see {@link candidateLabel}. */
  label: string;
  /** Agent-supplied caption / summary, when present. */
  description?: string;
}

/** Map a {@link RankedCandidate} to a {@link DropTitleItem}, attaching an optional description. */
export function toTitleItem(item: RankedCandidate, description?: string): DropTitleItem {
  return { ordinal: item.ordinal, label: candidateLabel(item.candidate), description: trimOrUndefined(description) };
}

function renderTitleItem(item: DropTitleItem): string {
  const desc = item.description ? ` — "${item.description}"` : '';
  return `  #${item.ordinal}  ${item.label}${desc}`;
}

/**
 * Build the confirmation-dialog title. It echoes the RESOLVED items
 * (recency ordinal + label + size + description) so the human verifies
 * targeting before anything drops, plus any tail-guarded / missing
 * ordinals so refused targets are visible.
 */
export function buildDropTitle(args: {
  /** Verb phrase for the action, e.g. `drop` / `collapse`. */
  verb: string;
  /** Noun for the targets, e.g. `image(s)` / `tool output(s)`. */
  noun: string;
  items: DropTitleItem[];
  guarded?: DropTitleItem[];
  missing?: number[];
  reason?: string;
}): string {
  const { verb, noun, items, guarded = [], missing = [], reason } = args;
  const lines: string[] = [];
  const reasonTail = reason?.trim() ? `\n\nReason: ${reason.trim()}` : '';
  lines.push(`⚠️  The model wants to ${verb} ${items.length} ${noun} (REVERSIBLE):`);
  lines.push('');
  for (const item of items) lines.push(renderTitleItem(item));
  if (guarded.length > 0) {
    lines.push('');
    lines.push(`Protected by the tail-guard (NOT ${verb}ped):`);
    for (const item of guarded) lines.push(renderTitleItem(item));
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`No candidate at: ${missing.map((m) => `#${m}`).join(', ')}`);
  }
  lines.push(reasonTail ? reasonTail : '');
  lines.push('Nothing is deleted from the transcript or disk. How should pi proceed?');
  return lines.join('\n');
}

/**
 * Resolve the non-interactive fallback (`PI_CONTEXT_TRIM_DROP_DEFAULT`):
 * `allow` only when set exactly to `allow`; everything else (unset,
 * `deny`, junk) is the conservative `deny`, matching `bash-permissions`.
 */
export function nonInteractiveDropDefault(raw: string | undefined): 'allow' | 'deny' {
  return raw?.trim().toLowerCase() === 'allow' ? 'allow' : 'deny';
}

/**
 * Shape of an `AgentToolResult` the drop / collapse tools return: a single
 * text content block + structured `details` + an optional error flag.
 * Shared so both tool shells annotate their `reply` helper identically.
 */
export interface DropToolResult<D> {
  content: { type: 'text'; text: string }[];
  details: D;
  isError?: boolean;
}
