/**
 * Pure snapshot + formatter for the `/roleplay lore` readout: what the last
 * narrative turn's lore selection kept and dropped, plus the live
 * sticky / cooldown timing state. The extension captures the snapshot where
 * lore is selected (`buildLoreInjection` / `buildDepthLore`) and owns the
 * state reads; this module turns them into the display string. No pi imports.
 */

import { type BudgetResult } from './budget.ts';
import { type TimingState } from './timing.ts';

export interface KeptLoreRow {
  id: string;
  name: string;
  order: number;
  /** Injected (trimmed, macro-substituted) body length. */
  chars: number;
}

export interface DroppedLoreRow {
  id: string;
  name: string;
  order: number;
}

export interface DepthLoreRow {
  id: string;
  name: string;
  depth: number;
}

/** Lore selection captured for one narrative turn. */
export interface LoreSelectionSnapshot {
  /** Narrative turn counter value the selection ran at. */
  turn: number;
  keywordKept: KeptLoreRow[];
  keywordDropped: DroppedLoreRow[];
  /** Depth-tagged lore kept; `null` until depth selection ran this turn. */
  depthKept: DepthLoreRow[] | null;
  depthDropped: DepthLoreRow[];
}

export function createLoreSelection(turn: number): LoreSelectionSnapshot {
  return { turn, keywordKept: [], keywordDropped: [], depthKept: null, depthDropped: [] };
}

/** Record a keyword-lore budget pass into `snap`. */
export function recordKeywordSelection(snap: LoreSelectionSnapshot, result: BudgetResult): void {
  snap.keywordKept = result.kept.map((c) => ({
    id: c.entry.id,
    name: c.entry.name,
    order: c.entry.lore?.order ?? 0,
    chars: c.body.length,
  }));
  snap.keywordDropped = result.dropped.map((e) => ({ id: e.id, name: e.name, order: e.lore?.order ?? 0 }));
}

/** Record a depth-lore budget pass into `snap`. */
export function recordDepthSelection(snap: LoreSelectionSnapshot, result: BudgetResult): void {
  snap.depthKept = result.kept.map((c) => ({ id: c.entry.id, name: c.entry.name, depth: c.entry.lore?.depth ?? 0 }));
  snap.depthDropped = result.dropped.map((e) => ({ id: e.id, name: e.name, depth: e.lore?.depth ?? 0 }));
}

export interface LoreTimingRow {
  id: string;
  name: string;
  /** Future turns the entry stays force-active (sticky carry). */
  stickyTurns: number;
  /** Future turns after the sticky window during which it cannot freshly fire. */
  cooldownTurns: number;
}

/**
 * Active timing windows as of `turn` (the last narrative turn). A fresh fire
 * at turn T arms `stickyUntil = T + sticky + 1` and
 * `cooldownUntil = stickyUntil + cooldown`; carry applies while
 * `t < stickyUntil` and the cooldown blocks while `t < cooldownUntil`, so
 * counts are measured over the turns after `turn`. Rows with neither window
 * open are omitted; sorted by name.
 */
export function loreTimingRows(
  state: Readonly<Record<string, TimingState>>,
  turn: number,
  nameOf: (id: string) => string | undefined,
): LoreTimingRow[] {
  const rows: LoreTimingRow[] = [];
  for (const [id, st] of Object.entries(state)) {
    const stickyTurns = Math.max(0, st.stickyUntil - 1 - turn);
    const cooldownTurns = Math.max(0, st.cooldownUntil - Math.max(st.stickyUntil, turn + 1));
    if (stickyTurns === 0 && cooldownTurns === 0) continue;
    rows.push({ id, name: nameOf(id) ?? id, stickyTurns, cooldownTurns });
  }
  return rows.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface LoreReadoutOptions {
  /** Keyword + depth lorebook enabled (env kill-switches and reminders). */
  lorebookEnabled: boolean;
  /** Last narrative turn's selection, or `null` before the first one. */
  snapshot: LoreSelectionSnapshot | null;
  /** Live turn counter. */
  turn: number;
  /** Live timing state (see {@link loreTimingRows}). */
  timingState: Readonly<Record<string, TimingState>>;
  nameOf: (id: string) => string | undefined;
  /** Activated lore bundles (PI_ROLEPLAY_LORE_BUNDLES), ascending precedence. */
  bundles: readonly string[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function timingLine(row: LoreTimingRow): string {
  const parts: string[] = [];
  if (row.stickyTurns > 0) parts.push(`sticky ${plural(row.stickyTurns, 'turn')}`);
  if (row.cooldownTurns > 0) parts.push(`cooldown ${plural(row.cooldownTurns, 'turn')}`);
  return `    ${row.name}: ${parts.join(', then ')}`;
}

/** Format the `/roleplay lore` readout. */
export function formatLoreReadout(opts: LoreReadoutOptions): string {
  const bundles = opts.bundles.length > 0 ? opts.bundles.join(', ') : '(none)';
  const head = [`Roleplay lore (turn ${opts.turn}; bundles: ${bundles})`];
  if (!opts.lorebookEnabled) {
    return [
      ...head,
      '  Lorebook is disabled (PI_ROLEPLAY_DISABLE_LOREBOOK or context reminders off); nothing is selected.',
    ].join('\n');
  }
  const snap = opts.snapshot;
  if (!snap) {
    return [...head, '  No narrative turn yet: lore is selected on your next roleplay message.'].join('\n');
  }
  const lines = [...head, `  Last selection: turn ${snap.turn}`];
  lines.push(`  Keyword lore kept (${snap.keywordKept.length}):`);
  if (snap.keywordKept.length === 0) lines.push('    (none fired)');
  for (const r of snap.keywordKept) lines.push(`    ${r.name}  order=${r.order}  ${r.chars} chars`);
  if (snap.keywordDropped.length > 0) {
    lines.push(`  Dropped by the lore budget (${snap.keywordDropped.length}):`);
    for (const r of snap.keywordDropped) lines.push(`    ${r.name}  order=${r.order}`);
  }
  if (snap.depthKept === null) {
    lines.push('  Depth lore: not selected this turn');
  } else {
    lines.push(`  Depth lore kept (${snap.depthKept.length}):`);
    if (snap.depthKept.length === 0) lines.push('    (none matched)');
    for (const r of snap.depthKept) lines.push(`    ${r.name}  depth=${r.depth}`);
    if (snap.depthDropped.length > 0) {
      lines.push(`  Depth lore dropped by the budget (${snap.depthDropped.length}):`);
      for (const r of snap.depthDropped) lines.push(`    ${r.name}  depth=${r.depth}`);
    }
  }
  const timing = loreTimingRows(opts.timingState, opts.turn, opts.nameOf);
  lines.push(`  Timing windows (${timing.length}):`);
  if (timing.length === 0) lines.push('    (no active sticky or cooldown)');
  for (const row of timing) lines.push(timingLine(row));
  return lines.join('\n');
}
