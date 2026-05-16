/**
 * Cost + usage hook shared by every research subagent spawn.
 *
 * The deep-research pipeline spawns multiple one-shot child sessions
 * (planner / self-critic / planning-critic / fanout workers / synth /
 * merge / structural / subjective critic / refinement). Each child
 * emits `message_end` events whose `message.usage.cost.total` field
 * carries the USD cost of that assistant turn (pi populates it from
 * the underlying provider's usage payload — see
 * `@earendil-works/pi-ai`'s `Usage` type).
 *
 * Before this module landed those numbers were silently dropped:
 *
 *   - the `PhaseEvent` union in `deep-research-statusline` has
 *     always accepted a `{kind:'cost', deltaUsd}` event, but nothing
 *     emitted it, so the statusline widget's "cost $0.000000" line
 *     was permanently zero;
 *   - the one-shot helper in `subagent-spawn` defaults to an in-
 *     memory `SessionManager`, so no child transcript reached disk
 *     and `ai-tool-usage` / `pi session-usage` could not attribute
 *     research runs to their parent session either.
 *
 * The extension shell fixes (A) by persisting every child under
 * `<projectSessionsDir>/<parentId>/subagents/`; this module fixes
 * (B) by producing an `onEvent` callback compatible with
 * `runOneShotAgent.onEvent` (and, by shape, with
 * `AgentSession.subscribe` for the long-lived parent session used
 * by the planner / self-critic path). On every assistant
 * `message_end` the hook extracts `usage.cost.total` and routes it
 * into the three sinks research callers may care about:
 *
 *   1. the statusline reducer (`emit({kind:'cost', deltaUsd})`),
 *   2. a `PhaseTracker.addCost(usd)` for callers using
 *      `research-budget.trackPhase` (the tracker already guards
 *      against NaN / negative / Infinity), and
 *   3. a journal line via `research-journal.appendJournal` when a
 *      `journalPath` is provided — so the per-run `journal.md`
 *      records the cost attributable to each phase alongside the
 *      existing step/warn entries.
 *
 * All three sinks are independent: pass whichever subset you need
 * and the hook no-ops on the rest. Sink failures are swallowed —
 * observability must never break a child spawn.
 *
 * No pi imports: the input shapes mirror the narrow types already
 * exported from `subagent-spawn.ts`, so a unit test can drive the
 * hook by hand with a `message_end` payload and assert all three
 * sinks fire with the right delta.
 */

import { type PhaseEvent } from './deep-research-statusline.ts';
import { type PhaseTracker } from './research-budget.ts';
import { appendJournal, type JournalLevel } from './research-journal.ts';

// ──────────────────────────────────────────────────────────────────────
// Inputs.
// ──────────────────────────────────────────────────────────────────────

/**
 * Shape we need off the event passed to `AgentSession.subscribe` /
 * `runOneShotAgent.onEvent`. A superset is fine — we only read
 * `type`, `message.role`, and `message.usage.cost.total`.
 */
export interface CostEventLike {
  type: string;
  message?: {
    role?: string;
    usage?: {
      cost?: {
        total?: number;
      };
    };
  };
}

/**
 * Options the extension threads into `createCostHook`.
 *
 *   - `emit`        — statusline emitter (`statusline.emit`). When
 *                     set, assistant cost deltas are forwarded as
 *                     `{kind:'cost', deltaUsd}`.
 *   - `tracker`     — phase tracker from `research-budget.trackPhase`.
 *                     When set, the same delta is passed to
 *                     `tracker.addCost` (which guards NaN / negative
 *                     values itself).
 *   - `journalPath` — when set, every delta appends a `cost` entry
 *                     to `journal.md` via `appendJournal`. Pair with
 *                     `phase` so the entry's heading carries the
 *                     phase name.
 *   - `phase`       — short label used in the journal heading
 *                     ("planner", "fanout:sq-1", "critic", ...).
 *                     Defaults to `unknown` when `journalPath` is
 *                     set but `phase` is not.
 *   - `journalLevel`— journal severity; defaults to `step`. Callers
 *                     logging cost noise (e.g. a repeat critic
 *                     iteration) can bump to `warn` if they want it
 *                     to stand out.
 *   - `minDeltaUsd` — filter threshold. Entries with
 *                     `total < minDeltaUsd` are counted (still
 *                     emitted / tracked) but skipped for journaling
 *                     — avoids flooding the journal on cached /
 *                     zero-cost turns. Default: `0` (journal every
 *                     assistant turn with a non-zero cost).
 */
export interface CostHookOptions {
  emit?: (event: PhaseEvent) => void;
  tracker?: Pick<PhaseTracker, 'addCost'>;
  journalPath?: string;
  phase?: string;
  journalLevel?: JournalLevel;
  minDeltaUsd?: number;
}

/**
 * Handle returned by `createCostHook`. `onEvent` is the callback to
 * pass to `runOneShotAgent.onEvent`; `subscribe` is the callback to
 * pass to `AgentSession.subscribe` (the two APIs differ only in the
 * event wrapper — the one-shot helper wraps the child event in
 * `{event, turn, abort}`; the parent session delivers the bare
 * event).
 *
 * `totalUsd` is the cumulative cost the hook has routed, readable
 * mid-run without tearing through the statusline state. Useful for
 * spec assertions.
 */
export interface CostHook {
  onEvent: (wrapped: { event: CostEventLike }) => void;
  subscribe: (event: CostEventLike) => void;
  readonly totalUsd: number;
}

// ──────────────────────────────────────────────────────────────────────
// Factory.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a cost-aggregation hook.
 *
 * Every call returns a fresh state object (total = 0). Pass the
 * same hook into a single `runOneShotAgent` invocation (or one
 * `AgentSession.subscribe` lifetime); share across spawns only if
 * you want a cumulative counter across them.
 */
export function createCostHook(opts: CostHookOptions = {}): CostHook {
  let total = 0;

  const handle = (event: CostEventLike): void => {
    if (event.type !== 'message_end') return;
    if (event.message?.role !== 'assistant') return;
    const raw = event.message.usage?.cost?.total;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return;

    total += raw;

    if (opts.emit) {
      try {
        opts.emit({ kind: 'cost', deltaUsd: raw });
      } catch {
        /* swallow — observability must never break the spawn */
      }
    }
    if (opts.tracker) {
      try {
        opts.tracker.addCost(raw);
      } catch {
        /* swallow */
      }
    }
    if (opts.journalPath && raw >= (opts.minDeltaUsd ?? 0)) {
      try {
        appendJournal(opts.journalPath, {
          level: opts.journalLevel ?? 'step',
          heading: `cost delta · ${opts.phase ?? 'unknown'} · ${raw.toFixed(6)} USD`,
        });
      } catch {
        /* swallow */
      }
    }
  };

  return {
    onEvent: ({ event }): void => handle(event),
    subscribe: (event): void => handle(event),
    get totalUsd(): number {
      return total;
    },
  };
}
