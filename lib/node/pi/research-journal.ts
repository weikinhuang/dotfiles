/**
 * Append-only markdown journal for a research run.
 *
 * Every step of a `/research` or `/lab` invocation writes a short
 * entry here: "planner produced N sub-questions", "fetched source X",
 * "quarantined finding F-3 for schema violation", "watchdog aborted
 * handle H-7". The journal is the human-readable ground truth for
 * "what happened during this run" and the input format the status
 * widget tails during a live run.
 *
 * Format is markdown so it renders in any editor without post-
 * processing. Each entry is a level-2 heading line followed by an
 * optional indented body block:
 *
 *     ## [2025-01-02T03:04:05.000Z] [info] Planner produced 5 sub-questions
 *
 *     First sub-question: "What …"
 *     …
 *
 * Entries are separated by a blank line. Parsing is deliberately
 * forgiving — a corrupt entry is skipped, not fatal.
 *
 * Atomicity: `appendJournal` reads the whole file, appends the new
 * entry, and writes the full new contents through `atomicWriteFile`.
 * That keeps the on-disk file either fully-before or fully-after the
 * append; a crash mid-call produces zero partial entries. The cost
 * is O(file size) per append, which is fine for the expected scale
 * (hundreds of entries per run, rarely more than a few MB).
 *
 * No pi imports.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';

// ──────────────────────────────────────────────────────────────────────
// Types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Severity / category for a journal entry.
 *
 *   - `info`  — routine observation ("cache hit", "skipped X").
 *   - `step`  — a meaningful pipeline transition ("planner done").
 *   - `warn`  — something recoverable went wrong.
 *   - `error` — something non-recoverable happened; callers SHOULD
 *     pair this with a quarantine or a stuck escalation.
 */
export type JournalLevel = 'info' | 'step' | 'warn' | 'error';

/**
 * Ordered set of known levels. Used by the parser to decide whether
 * a bracketed token on a heading line is a level discriminator (vs.
 * just another bracketed token in the heading text).
 */
const LEVELS: readonly JournalLevel[] = ['info', 'step', 'warn', 'error'];

export interface JournalEntry {
  /** ISO8601 UTC timestamp. */
  ts: string;
  /** One of the known levels. */
  level: JournalLevel;
  /** Heading line (free-form; may contain markdown). */
  heading: string;
  /** Optional body. Absent when the entry was heading-only. */
  body?: string;
}

export interface AppendJournalInput {
  level: JournalLevel;
  heading: string;
  body?: string;
  /**
   * Optional explicit timestamp. Callers pass a frozen value in
   * tests; production callers let the default `new Date()` fill it
   * in. We keep `ts` overridable (rather than deriving it from a
   * clock source param everywhere) because the journal is a
   * natural place to back-date an entry on replay.
   */
  ts?: Date;
}

// ──────────────────────────────────────────────────────────────────────
// Append.
// ──────────────────────────────────────────────────────────────────────

/**
 * Format a single entry as markdown. The heading is a `## [ts]
 * [level] <heading>` line; the optional body follows after one blank
 * line with no further escaping. Body content is assumed to be
 * author-trusted markdown (the journal is private to the run).
 */
function renderEntry(entry: JournalEntry): string {
  const head = `## [${entry.ts}] [${entry.level}] ${entry.heading}`;
  if (entry.body === undefined) return `${head}\n`;
  // Strip a single trailing newline from body so rendering stays
  // consistent with and without a terminator in the input.
  const body = entry.body.replace(/\n+$/, '');

  return `${head}\n\n${body}\n`;
}

/**
 * Glue together an existing document and a new entry, making sure
 * there is exactly one blank line separating them. We trim trailing
 * whitespace/newlines from the existing doc before joining so
 * entries stay visually tidy even if a caller manually edited the
 * file and left stray blank lines.
 */
function appendWithSeparator(existing: string, entry: string): string {
  const trimmed = existing.replace(/\s+$/, '');

  return `${trimmed}\n\n${entry}`;
}

/**
 * Append a single entry to the journal at `journalPath`. Creates the
 * file if it doesn't exist. Safe under concurrent callers against
 * *different* journal paths; two callers appending to the *same*
 * path concurrently race at the last-write-wins level (use a
 * per-run journal, which is the toolkit's own convention).
 */
export function appendJournal(journalPath: string, input: AppendJournalInput): void {
  const ts = (input.ts ?? new Date()).toISOString();
  const entry = renderEntry({
    ts,
    level: input.level,
    heading: input.heading,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });

  const existing = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
  const next = existing.length === 0 ? entry : appendWithSeparator(existing, entry);
  atomicWriteFile(journalPath, next);
}

// ──────────────────────────────────────────────────────────────────────
// Parse + read.
// ──────────────────────────────────────────────────────────────────────

/**
 * Heading-line matcher. Requires the line to start with `## [` so
 * bracketed mentions elsewhere in the heading text don't accidentally
 * look like new entries. The third bracket is the level token —
 * matched permissively here and filtered by `LEVELS` membership
 * later so an unknown level cleanly demotes the line to body text.
 */
const HEADING_RE = /^## \[([^\]]+)\] \[([^\]]+)\]\s*(.*)$/;

function isJournalLevel(v: unknown): v is JournalLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

function parse(text: string): JournalEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: JournalEntry[] = [];
  let current: { ts: string; level: JournalLevel; heading: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    // Strip only leading/trailing newlines — NOT all whitespace — so
    // indented body content (e.g. a code block starting with spaces)
    // round-trips without losing its indentation. The leading-newline
    // case is created by the blank separator line between a heading
    // and its body, which lands as `current.body[0] = ''` during
    // parsing.
    const bodyText = current.body.join('\n').replace(/^\n+|\n+$/g, '');
    const entry: JournalEntry = {
      ts: current.ts,
      level: current.level,
      heading: current.heading,
    };
    if (bodyText.length > 0) entry.body = bodyText;
    entries.push(entry);
    current = null;
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const [, ts, level, heading] = m;
      if (isJournalLevel(level) && typeof ts === 'string' && typeof heading === 'string') {
        flush();
        current = { ts, level, heading: heading.trim(), body: [] };
        continue;
      }
      // Unknown level token: treat as body content if we're
      // already inside an entry, else drop.
    }
    if (current) {
      current.body.push(line);
    }
  }
  flush();

  return entries;
}

/**
 * Read the journal and return all entries in chronological order
 * (oldest first). A missing file returns an empty array. Malformed
 * regions (everything before the first heading, blocks whose
 * heading line doesn't parse) are silently dropped — the journal is
 * a debugging tool, not a schema-validated store.
 */
export function readJournal(journalPath: string): JournalEntry[] {
  if (!existsSync(journalPath)) return [];

  return parse(readFileSync(journalPath, 'utf8'));
}

/**
 * Read the last `n` entries (chronological, oldest first within the
 * returned slice). Useful for the status widget. `n <= 0` returns
 * the empty array. When the journal has fewer entries than `n`, the
 * full list is returned.
 */
export function tailJournal(journalPath: string, n: number): JournalEntry[] {
  if (n <= 0) return [];
  const all = readJournal(journalPath);
  if (all.length <= n) return all;

  return all.slice(all.length - n);
}

/**
 * Regex matching the cost-delta journal heading written by
 * `research-cost-hook.createCostHook`: `cost delta · <phase> ·
 * <USD> USD`. Group 1 is the phase label, group 2 the dollar
 * amount. Kept here (not on the hook side) because every reader
 * of the journal needs to parse it; one regex, one definition.
 */
const COST_DELTA_HEADING = /^cost delta · (.+?) · ([0-9]+(?:\.[0-9]+)?) USD$/;

/**
 * Regex matching the `total=<USD> USD …` line at the bottom of a
 * `cost report` entry body (written by
 * `research-budget-live.appendSummary`). Multi-line flag anchors
 * it to the start of a body line — the body also contains
 * `phase=<name> spent=<USD> USD wall=<seconds>s` lines which the
 * regex explicitly does NOT match (would double-count against the
 * `total=` line). Group 1 is the dollar amount.
 */
const COST_REPORT_TOTAL_LINE = /^total=([0-9]+(?:\.[0-9]+)?) USD\b/m;

/**
 * Sum cumulative USD spend recorded in the journal. Prefers
 * per-turn `cost delta · <phase> · <USD> USD` headings written by
 * `research-cost-hook.createCostHook` — those are higher
 * resolution and survive resumes as a natural append. Falls back
 * to the `total=<USD> USD` line inside every `cost report` entry
 * body written by `research-budget-live.appendSummary` at
 * pipeline exit, summing across multiple reports so resumes
 * accumulate.
 *
 * Concretely: returns `max(sumDeltas, sumReportTotals)`. When
 * both sources are populated for the same work they should agree
 * (the report total IS the sum of per-turn deltas); `max` is
 * defensive against either side under-reporting. The edge case
 * where one resume segment has only deltas and another has only a
 * cost report would under-report — documented but not handled,
 * since the common case is uniform hook behavior per run.
 *
 * Used by `/research --list` to surface a real cost column
 * (plan.json doesn't track cost) and by the `/research --resume`
 * flow to journal a cumulative-cost line on re-entry so the user
 * can see the accrued spend across resumes.
 *
 * Malformed dollar strings (the regex already rejects non-numeric
 * tokens) are silently dropped — the journal is advisory, not a
 * ledger; a bad line must never break the table render.
 */
export function sumJournalCostUsd(journalPath: string): number {
  const entries = readJournal(journalPath);
  let deltaSum = 0;
  let reportSum = 0;
  for (const entry of entries) {
    const deltaMatch = COST_DELTA_HEADING.exec(entry.heading);
    if (deltaMatch) {
      const usd = Number(deltaMatch[2]);
      if (Number.isFinite(usd) && usd >= 0) deltaSum += usd;
      continue;
    }
    if (entry.heading === 'cost report' && entry.body) {
      const reportMatch = COST_REPORT_TOTAL_LINE.exec(entry.body);
      if (reportMatch) {
        const usd = Number(reportMatch[1]);
        if (Number.isFinite(usd) && usd >= 0) reportSum += usd;
      }
    }
  }
  return Math.max(deltaSum, reportSum);
}
