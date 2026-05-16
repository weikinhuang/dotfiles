/**
 * Session-scoped aggregate of subagent usage, shared between the
 * `subagent` extension (which records each completed run) and the
 * `statusline` extension (which renders the running totals on line 2
 * alongside the main-session `M(…)` / `S:` / `⚒ S:` segments).
 *
 * pi loads each extension via its own jiti instance with
 * `moduleCache: false`, so a plain module-level `let singleton`
 * produces two separate objects - one inside the subagent extension
 * and one inside the statusline extension. We anchor the aggregate
 * on `globalThis` behind a `Symbol.for()` key so both copies resolve
 * to the same underlying instance, matching the pattern used by
 * `lib/node/pi/bash-gate.ts` and `session-flags.ts`.
 *
 * The reducer is deliberately pure - no pi imports - so it can be
 * exercised under vitest without spinning up the extension runtime.
 * Callers feed it plain numbers and a `failed` flag; the module never
 * inspects live subagent state on its own.
 *
 * Reset semantics: the aggregate is scoped to a single parent pi
 * session. The subagent extension calls `.reset()` from its
 * `session_start` handler so counts don't bleed across `/new` or a
 * session switch. The statusline reads snapshots but never mutates.
 */

export interface SubagentRunRecord {
  /** Total turns the child used. */
  turns: number;
  /** Child-side token and cost totals. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
  /** Wall-clock duration of the child run in milliseconds. */
  durationMs: number;
  /** True when the child stopped with an error / abort / max_turns. */
  failed: boolean;
}

export interface SubagentAggregateSnapshot {
  /** Number of completed subagent runs recorded this session. */
  count: number;
  /** Subset of `count` that stopped with a non-`completed` reason. */
  failures: number;
  /** Sum of child turns across all recorded runs. */
  turns: number;
  /** Sum of child token counters across all recorded runs. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Sum of child cost across all recorded runs (USD, as reported by pi). */
  cost: number;
  /** Sum of wall-clock duration across all recorded runs. */
  totalDurationMs: number;
}

export interface SubagentAggregate {
  snapshot(): SubagentAggregateSnapshot;
  record(run: SubagentRunRecord): void;
  reset(): void;
}

function emptySnapshot(): SubagentAggregateSnapshot {
  return {
    count: 0,
    failures: 0,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    totalDurationMs: 0,
  };
}

/**
 * Build a fresh aggregator. Exported primarily for vitest; production
 * code should use `getSessionSubagentAggregate()` so both extensions
 * observe the same counters.
 */
export function makeSubagentAggregate(): SubagentAggregate {
  let state = emptySnapshot();
  return {
    snapshot(): SubagentAggregateSnapshot {
      // Return a copy so callers can't mutate our state by accident.
      return { ...state };
    },
    record(run: SubagentRunRecord): void {
      state = {
        count: state.count + 1,
        failures: state.failures + (run.failed ? 1 : 0),
        turns: state.turns + run.turns,
        input: state.input + run.input,
        cacheRead: state.cacheRead + run.cacheRead,
        cacheWrite: state.cacheWrite + run.cacheWrite,
        output: state.output + run.output,
        cost: state.cost + run.cost,
        totalDurationMs: state.totalDurationMs + run.durationMs,
      };
    },
    reset(): void {
      state = emptySnapshot();
    },
  };
}

// Cross-extension singleton anchored on `globalThis` so every
// jiti-loaded copy of this module resolves to the same instance.
// `Symbol.for()` participates in Node's global symbol registry, so
// two realms that import this file still agree on the key.
interface AggregateSlot {
  instance?: SubagentAggregate;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/subagent-aggregate');

function getSlot(): AggregateSlot {
  const g = globalThis as { [SLOT_KEY]?: AggregateSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Returns the pi-process singleton aggregator. Both the subagent and
 * statusline extensions call this to find each other without having
 * to publish an explicit handle across extension boundaries.
 */
export function getSessionSubagentAggregate(): SubagentAggregate {
  const slot = getSlot();
  slot.instance ??= makeSubagentAggregate();
  return slot.instance;
}

/**
 * Test-only: drop the cached singleton so subsequent
 * `getSessionSubagentAggregate()` calls rebuild a fresh aggregate.
 * Production code should use `.reset()` on the returned instance
 * instead; this exists for vitest isolation.
 */
export function __resetSessionSubagentAggregateForTests(): void {
  const slot = getSlot();
  slot.instance = undefined;
}
