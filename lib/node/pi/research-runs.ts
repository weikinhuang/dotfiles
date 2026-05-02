/**
 * Pure helpers for the deep-research extension's `/research --list`
 * and `/research --selftest` commands.
 *
 * Lives under `lib/node/pi/` (no pi imports) so the extension file
 * can stay a thin shell and these helpers are unit-testable without
 * a running pi session. The extension shell at
 * `config/pi/extensions/deep-research.ts` wires these into
 * `pi.registerCommand`.
 *
 * Phase-1 scope:
 *
 *   - `listRuns(cwd)` walks `<cwd>/research/*`, skips the `lab/`
 *     subdirectory (that's autoresearch's tree, listed by a
 *     separate `/lab --list` command), and tries to load each
 *     slug's `plan.json` via `research-plan.readPlan`. Runs whose
 *     plan parses but isn't a deep-research plan are filtered out
 *     (they belong to a sibling extension).
 *   - `formatRunsTable(runs)` formats the summary as a fixed-width
 *     text table — `slug | status | wall-clock | cost`. Empty input
 *     returns a friendly "no runs found" sentence so the command
 *     output is never blank.
 *   - `formatSelftestResult(result)` pretty-prints the selftest
 *     outcome (pass / per-file diff summary) for the
 *     `/research --selftest` command.
 *   - `runListCommand(deps)` + `runSelftestCommand(deps)` glue the
 *     above into the extension's command handlers with injected
 *     `notify` so tests don't need the pi runtime.
 *
 * Wall-clock is derived from `journal.md` (first → last entry
 * timestamp) because the plan schema doesn't track elapsed time
 * yet. Cost isn't tracked at all in Phase 1, so the table shows
 * "—" for missing fields. Phase 5 wires statusline widgets that
 * will populate richer stats; until then the table stays honest
 * about what it knows.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readJournal } from './research-journal.ts';
import { paths, runRoot } from './research-paths.ts';
import { PlanValidationError, readPlan } from './research-plan.ts';
import { type SelftestDiff, type SelftestResult } from './research-selftest.ts';
import { fmtCost } from './token-format.ts';

// ──────────────────────────────────────────────────────────────────────
// Private constants + helpers
// ──────────────────────────────────────────────────────────────────────

/** Name reserved by the autoresearch extension — skipped by `listRuns`. */
const LAB_DIRNAME = 'lab';

/** Placeholder shown when a column's value is unknown. */
const UNKNOWN_CELL = '—';

/**
 * Maximum per-diff rows surfaced by `formatSelftestResult` before
 * collapsing the tail into a `… N more` footer. Chosen to keep a
 * failed-selftest notification reasonably short while still letting
 * the user see enough context to locate the regression.
 */
const SELFTEST_DIFF_PREVIEW_CAP = 10;

/**
 * Derive wall-clock elapsed seconds from the journal's first and
 * last entry timestamps. Returns `null` when the journal is
 * missing, empty, or the timestamps fail to parse.
 */
function wallClockFromJournal(journalPath: string): number | null {
  const entries = readJournal(journalPath);
  if (entries.length === 0) return null;
  const first = Date.parse(entries[0].ts);
  const last = Date.parse(entries[entries.length - 1].ts);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const deltaMs = last - first;
  if (deltaMs < 0) return null;

  return Math.round(deltaMs / 1000);
}

/** Human-readable wall-clock duration (`3m 42s`, `1h 02m 05s`).
 *
 * Deliberately *not* reusing `bg-bash-reducer.formatDuration(ms)` or
 * `btw.formatDuration(ms)` here:
 *
 *   - Input unit is seconds (what we compute from journal deltas),
 *     not milliseconds.
 *   - Research runs routinely span minutes-to-hours, so we always
 *     render the minute + second parts (zero-padded) so adjacent
 *     table rows stay column-aligned. `bg-bash` drops zero seconds
 *     (`1h5m`) which makes a stacked-durations table jagged.
 *
 * If a shared multi-unit duration formatter ever lands under
 * `lib/node/pi/shared.ts`, this helper is the obvious caller to
 * migrate first.
 */
function formatWallClock(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;

  return `${hours}h ${rem.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-slug summary row surfaced by `/research --list`. Every field
 * is present but may be `null` when the underlying source of truth
 * isn't populated yet (no plan, no journal, cost not tracked in
 * Phase 1). `error` is non-null for slugs whose plan.json failed
 * to load or parse — the row is still returned so the user can see
 * the broken run and decide what to do with it.
 */
export interface RunSummary {
  slug: string;
  /** Plan top-level status (e.g. `planning`, `fanout`, `done`). */
  status: string | null;
  /** Journal-derived elapsed seconds (first → last entry). */
  wallClockSec: number | null;
  /** Spent USD. Not tracked in Phase 1 — always null. */
  costUsd: number | null;
  /** Parse/load error if plan.json is missing or malformed. */
  error: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// listRuns / summarizeRun
// ──────────────────────────────────────────────────────────────────────

/**
 * Load a single run's summary. Exported for composition; the
 * public entry point is `listRuns`.
 *
 * `wallClockSec` is ALWAYS derived from the journal when present,
 * regardless of whether the plan loaded cleanly — a broken or
 * kind-mismatched plan still has user-visible elapsed time worth
 * surfacing. `costUsd` is left `null` in Phase 1 (no runtime
 * accounting yet).
 */
export function summarizeRun(cwd: string, slug: string): RunSummary {
  const root = runRoot(cwd, slug);
  const p = paths(root);
  const wallClockSec = wallClockFromJournal(p.journal);

  if (!existsSync(p.plan)) {
    return { slug, status: null, wallClockSec, costUsd: null, error: 'plan.json not found' };
  }

  try {
    const plan = readPlan(p.plan);
    if (plan.kind !== 'deep-research') {
      // An autoresearch plan found outside `research/lab/` is
      // legal but not a deep-research run — surface the mismatch
      // so the user can relocate it rather than silently drop it.
      return {
        slug,
        status: null,
        wallClockSec,
        costUsd: null,
        error: `plan.json kind=${plan.kind} — not a deep-research run`,
      };
    }

    return { slug, status: plan.status, wallClockSec, costUsd: null, error: null };
  } catch (e) {
    // `PlanValidationError` carries a `path` pointer to the exact
    // field that failed validation — surface it so the `! …` row
    // in the list table points the user at the bad field rather
    // than just showing a generic parse error.
    const error =
      e instanceof PlanValidationError ? `plan validation failed at ${e.path}: ${e.message}` : (e as Error).message;

    return { slug, status: null, wallClockSec, costUsd: null, error };
  }
}

/**
 * Enumerate deep-research runs under `<cwd>/research/`.
 *
 * Non-directory entries and the `lab/` subdir are skipped. Each
 * remaining slug produces one `RunSummary`. Slugs without a
 * `plan.json` are surfaced with an `error` so users aren't
 * confused by silently-dropped directories.
 */
export function listRuns(cwd: string): RunSummary[] {
  const researchDir = join(cwd, 'research');
  if (!existsSync(researchDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(researchDir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const name of entries.sort()) {
    if (name === LAB_DIRNAME) continue;
    const abs = join(researchDir, name);
    let isDirectory = false;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    summaries.push(summarizeRun(cwd, name));
  }

  return summaries;
}

// ──────────────────────────────────────────────────────────────────────
// formatRunsTable
// ──────────────────────────────────────────────────────────────────────

/**
 * Format `runs` as a fixed-width text table with columns
 * `slug | status | wall-clock | cost`. Returns a friendly
 * empty-state message when `runs` is empty so the command always
 * produces non-blank output.
 */
export function formatRunsTable(runs: readonly RunSummary[]): string {
  if (runs.length === 0) {
    return 'No research runs found under ./research/. Run `/research <question>` to start one.';
  }

  const header = ['slug', 'status', 'wall-clock', 'cost'];
  const rows: string[][] = [header];
  for (const r of runs) {
    rows.push([
      r.slug,
      r.error ? `! ${r.error}` : (r.status ?? UNKNOWN_CELL),
      r.wallClockSec === null ? UNKNOWN_CELL : formatWallClock(r.wallClockSec),
      r.costUsd === null ? UNKNOWN_CELL : fmtCost(r.costUsd),
    ]);
  }

  const widths = header.map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  const separator = widths.map((w) => '-'.repeat(w)).join(' | ');
  const rendered = rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join(' | '));
  rendered.splice(1, 0, separator);

  return rendered.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// formatSelftestResult
// ──────────────────────────────────────────────────────────────────────

/**
 * Pretty-print a `SelftestResult` for command output. Success is a
 * single line so the user can see the pass at a glance; failure
 * shows the run root and a per-diff summary capped at 10 entries
 * (further diffs collapsed into a `… N more` line).
 */
export function formatSelftestResult(result: SelftestResult): string {
  if (result.ok) {
    return `/research --selftest: passed (run root: ${result.runRoot}).`;
  }
  const lines: string[] = [
    `/research --selftest: FAILED (${result.diffs.length} diff${result.diffs.length === 1 ? '' : 's'}).`,
    `Run root: ${result.runRoot}`,
  ];
  const preview = result.diffs.slice(0, SELFTEST_DIFF_PREVIEW_CAP);
  for (const d of preview) {
    lines.push(`  [${d.kind}] ${d.path}`);
  }
  if (result.diffs.length > preview.length) {
    lines.push(`  … ${result.diffs.length - preview.length} more`);
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Command orchestration
// ──────────────────────────────────────────────────────────────────────

/** Notify levels the extension cares about. Narrower than pi's full enum. */
export type CommandNotifyLevel = 'info' | 'warning' | 'error';

/** Minimal `notify` surface the command handlers depend on. */
export type CommandNotify = (message: string, level: CommandNotifyLevel) => void;

/**
 * Dependencies for `runListCommand` / `runSelftestCommand`.
 * Injecting `selftest` + `notify` lets tests drive the command
 * handlers without importing the pi runtime.
 */
export interface ListCommandDeps {
  cwd: string;
  notify: CommandNotify;
}

export interface SelftestCommandDeps {
  cwd: string;
  selftest: (opts: { cwd: string }) => Promise<SelftestResult>;
  notify: CommandNotify;
}

/** `/research --list` command handler. */
export function runListCommand(deps: ListCommandDeps): void {
  const runs = listRuns(deps.cwd);
  deps.notify(formatRunsTable(runs), 'info');
}

/**
 * `/research --selftest` command handler. Any thrown error from
 * `selftest` is caught and reported as an error notification so a
 * broken selftest doesn't crash the pi session.
 */
export async function runSelftestCommand(deps: SelftestCommandDeps): Promise<void> {
  let result: SelftestResult;
  try {
    result = await deps.selftest({ cwd: deps.cwd });
  } catch (e) {
    deps.notify(`/research --selftest: threw during execution: ${(e as Error).message}`, 'error');
    return;
  }
  deps.notify(formatSelftestResult(result), result.ok ? 'info' : 'error');
}

// Re-export `SelftestDiff` so consumers don't have to import from
// two modules when rendering diffs.
export type { SelftestDiff };
