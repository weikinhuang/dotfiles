/**
 * The "stuck" escape-hatch type - a first-class value a planner,
 * synthesizer, or critic can return instead of fabricating content
 * when it genuinely does not know how to proceed.
 *
 * The robustness principle this plan implements says: **failure is
 * either visibly quarantined or recovered; silent corruption is the
 * failure mode the design refuses.** `Stuck` is the recover-by-not-
 * fabricating side of that rule. When a typed-output call (see the
 * planned `research-structured.callTyped`) returns a `Stuck` value,
 * the caller decides whether to escalate, retry with a nudge, or
 * quarantine the input - but it never silently turns `Stuck` into
 * fake content.
 *
 * We compose `Stuck` into every typed-LLM-output schema used across
 * the research toolkit. Callers union `Stuck | T` so the model can
 * say "I don't know" without violating the schema.
 *
 * Plain-TS implementation (mirrors `iteration-loop-schema.ts`):
 * the plan lists TypeBox as the preferred schema library, but the
 * named precedent (`iteration-loop-schema.ts`) uses hand-rolled `is*`
 * validators, and `typebox` is not part of this project's root
 * tsconfig dependency set. Schemas here are TS types + runtime
 * validators so the pure modules type-check without the pi runtime.
 * When Phase 3 introduces `research-structured`, which already
 * depends on pi, it can layer TypeBox on top if the consumers want it.
 *
 * No pi imports. No filesystem access. No async.
 */

import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Type + constructor.
// ──────────────────────────────────────────────────────────────────────

/**
 * Discriminator string for a `Stuck` value. Exported so callers
 * building their own typed unions can reference the literal without
 * re-declaring it.
 */
export const STUCK_STATUS = 'stuck' as const;

/**
 * The structural shape the model emits - or that a caller constructs
 * when it wants to surface a `Stuck` locally. `reason` is mandatory
 * and must be non-empty; we treat an empty reason as a validation
 * failure on the spirit-of-the-API grounds that "I'm stuck, but I
 * won't say why" is indistinguishable from a malformed response.
 */
export interface Stuck {
  status: typeof STUCK_STATUS;
  reason: string;
}

/**
 * Canonical constructor. Callers should use this rather than the
 * object literal so the discriminator string stays canonical; if we
 * ever narrow `STUCK_STATUS`, the constructor keeps the call sites
 * consistent.
 *
 * Trims `reason`. Throws a `TypeError` if `reason` is empty after
 * trimming - a `Stuck` without a reason is not a legal value.
 */
export function stuck(reason: string): Stuck {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new TypeError('stuck(): reason must be a non-empty string');
  }
  return { status: STUCK_STATUS, reason: trimmed };
}

// ──────────────────────────────────────────────────────────────────────
// Runtime validator + type guard.
// ──────────────────────────────────────────────────────────────────────

/**
 * Does `v` match the structural `Stuck` shape? Used by the typed-
 * output parser to recognize a valid escape hatch before validating
 * against the caller's richer schema.
 *
 * Policy:
 *   - `status` must be exactly the literal `STUCK_STATUS`.
 *   - `reason` must be a non-empty string after trimming (an empty
 *     or whitespace-only reason is treated as malformed).
 *   - Extra fields are ignored - forward-compatible with future
 *     additions like a suggested next step.
 */
export function isStuckShape(v: unknown): v is Stuck {
  if (!isRecord(v)) return false;
  if (v.status !== STUCK_STATUS) return false;
  if (typeof v.reason !== 'string') return false;
  if (v.reason.trim().length === 0) return false;
  return true;
}

/**
 * Discriminating type guard for a union of `Stuck | T`. Callers
 * write:
 *
 *     const r = await callTyped<MyShape>(...);
 *     if (isStuck(r)) { handleStuck(r); return; }
 *     // r: MyShape from here on
 *
 * `T` is constrained to `object` so the union `Stuck | T` is a
 * discriminated union on `.status` - scalar `T` (e.g. `string`)
 * would not narrow.
 */
export function isStuck<T extends object>(v: Stuck | T): v is Stuck {
  // Use the shape validator rather than a bare `status === 'stuck'`
  // so callers passing an untrusted value get the same policy as the
  // parser (non-empty reason, object shape).
  return isStuckShape(v);
}
