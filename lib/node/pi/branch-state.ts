/**
 * Shared scaffolding for the todo / scratchpad reducers (and any future
 * "LLM-managed state mirrored into the session branch" extensions).
 *
 * No pi imports - testable under `vitest` with no runtime.
 *
 * The two reducer modules (`todo-reducer.ts`, `scratchpad-reducer.ts`)
 * share three nearly-identical pieces:
 *
 *   1. The `BranchEntry` duck-type describing the minimal shape of a
 *      pi session entry we inspect when replaying state.
 *   2. The `ActionResult<S>` discriminated union returned by every
 *      pure action handler - success carries the new state + a human
 *      summary, failure carries an error string.
 *   3. The branch-replay walk: each tool call mirrors its post-action
 *      state as BOTH a `toolResult.details` payload AND a
 *      `{ type: 'custom', customType: '<name>-state', data: ... }`
 *      entry. The reducer scans newest-first for the most recent
 *      valid snapshot and returns it (or `emptyState()`).
 *
 * Factoring these out keeps the per-reducer modules focused on their
 * *state shape and transition rules* rather than re-implementing the
 * same plumbing.
 */

/**
 * Minimal, duck-typed shape of a pi session entry. Real entries have
 * more fields; we only touch what we need so tests don't have to
 * fabricate whole SessionManager objects.
 */
export interface BranchEntry {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly details?: unknown;
  };
}

export interface ActionSuccess<S> {
  ok: true;
  state: S;
  summary: string;
}

export interface ActionError {
  ok: false;
  error: string;
}

export type ActionResult<S> = ActionSuccess<S> | ActionError;

/**
 * Extract a state snapshot from a single branch entry if it matches
 * either of the two mirrored-state shapes for `toolName` /
 * `customType`, returning `null` otherwise. `isShape` validates the
 * payload structure AND narrows the return type to `S`.
 *
 * Callers provide a `clone` fn so the returned value is a defensive
 * copy - the session entry payloads are owned by pi and we mustn't
 * alias them across actions.
 */
export function stateFromEntryGeneric<S>(
  entry: BranchEntry,
  toolName: string,
  customType: string,
  isShape: (value: unknown) => value is S,
  clone: (s: S) => S,
): S | null {
  // Custom mirror: { type: 'custom', customType: '<custom>', data: S }
  if (entry.type === 'custom' && entry.customType === customType) {
    return isShape(entry.data) ? clone(entry.data) : null;
  }
  // Tool result: { type: 'message', message: { role: 'toolResult', toolName, details: S } }
  if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === toolName) {
    return isShape(entry.message.details) ? clone(entry.message.details) : null;
  }
  return null;
}

/**
 * Walk `branch` newest-to-oldest and return the first valid state
 * snapshot found. Returns `null` when no entry matched - callers
 * typically fall back to their own `emptyState()`.
 */
export function findLatestStateInBranch<S>(
  branch: readonly BranchEntry[],
  toolName: string,
  customType: string,
  isShape: (value: unknown) => value is S,
  clone: (s: S) => S,
): S | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const s = stateFromEntryGeneric(branch[i], toolName, customType, isShape, clone);
    if (s) return s;
  }
  return null;
}
