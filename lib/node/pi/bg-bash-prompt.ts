/**
 * Pure helpers for rendering the bg-bash job registry as a system-prompt
 * block, injected into every turn via `before_agent_start`.
 *
 * No pi imports so this module can be unit-tested under `vitest`.
 *
 * The block is formatted as a short `## Background Jobs` section with
 * two subsections:
 *
 *   - **Running** — jobs with status `running` or `signaled` (signaled
 *     but not yet reaped). Always rendered, even when empty, because
 *     it's the state the model most needs to remember.
 *   - **Recent** — the most-recently-ended terminal jobs, capped.
 *
 * If there are no jobs at all we return `null` so the extension can skip
 * injection entirely.
 *
 * A soft character cap protects long-running sessions from inflating
 * the system prompt. When we bail early, we append a trailer pointing
 * the model at the `bg_bash list` action.
 */

import { type BgBashState, formatJobLine, type JobSummary, partitionJobs } from './bg-bash-reducer.ts';

const DEFAULT_RECENT_CAP = 5;

export interface FormatOptions {
  /** Soft cap on the rendered body in characters. Default 1500. */
  maxChars?: number;
  /** How many terminal jobs to include at most in the "Recent" list. Default 5. */
  recentCap?: number;
  /**
   * "Now" as epoch ms. Injected so the reducer's duration math produces
   * deterministic output under test.
   */
  now?: number;
}

/**
 * Build the "## Background Jobs" block. Returns `null` when there's
 * nothing to say (no running and no recent jobs) so the caller can skip
 * injection.
 */
export function formatBackgroundJobs(state: BgBashState, opts: FormatOptions = {}): string | null {
  const now = opts.now ?? Date.now();
  const cap = Math.max(200, opts.maxChars ?? 1500);
  const recentCap = Math.max(0, opts.recentCap ?? DEFAULT_RECENT_CAP);

  const { running, recent } = partitionJobs(state, { recentCap });
  if (running.length === 0 && recent.length === 0) return null;

  const lines: string[] = ['## Background Jobs', ''];

  // Track budget greedily. We ALWAYS render the header + the "Running"
  // subsection (even if empty, so the model learns the format); if
  // space runs out we trim the "Recent" section from the bottom.
  let used = lines.join('\n').length;
  let truncated = false;
  let skipped = 0;

  const pushLine = (line: string): void => {
    lines.push(line);
    used += line.length + 1;
  };

  pushLine('**Running**');
  if (running.length === 0) {
    pushLine('  (none)');
  } else {
    for (const j of running) {
      const rendered = `  - ${formatJobLine(j, now)}`;
      if (used + rendered.length + 1 > cap) {
        truncated = true;
        skipped++;
        continue;
      }
      pushLine(rendered);
    }
  }

  if (recent.length > 0) {
    pushLine('');
    pushLine('**Recent**');
    for (const j of recent) {
      const rendered = `  - ${formatJobLine(j, now)}`;
      if (used + rendered.length + 1 > cap) {
        truncated = true;
        skipped++;
        continue;
      }
      pushLine(rendered);
    }
  }

  pushLine('');
  if (truncated) {
    pushLine(`(${skipped} more job(s) not shown — call \`bg_bash\` with action \`list\` to see all.)`);
  } else {
    pushLine(
      'Use `bg_bash` (`status`, `logs`, `wait`, `signal`, `remove`) to inspect, steer, or reap these jobs. Start new ones with `start`; prefer this over the foreground `bash` tool for anything that may run long (dev servers, test suites, builds, watchers).',
    );
  }
  return lines.join('\n');
}

/**
 * Rough plaintext dump of the registry, used by the tool's `list` /
 * `status` text response when the renderer isn't available (print / JSON
 * modes).
 */
export function formatRegistryText(state: BgBashState, now: number = Date.now()): string {
  if (state.jobs.length === 0) return '(no background jobs)';
  return state.jobs.map((j: JobSummary) => formatJobLine(j, now)).join('\n');
}
