/**
 * Wrap-plan + statusline-mode resolution for the sandbox extension.
 *
 * Two views over the same precedence ladder (env-disable → session
 * bypass → unsupported platform → missing deps → root-without-override
 * → ready) used by:
 *
 *   - {@link resolveWrapPlan}: tells the bash hook whether to identity-
 *     wrap, send through the live ASRT manager, or block. Inputs come
 *     from `PI_SANDBOX_DISABLED`, the platform probe, and a session-
 *     only bypass flag toggled by `/sandbox-disable`.
 *   - {@link resolveSandboxMode}: tells the statusline which of the
 *     five visible states (`env-disabled`, `bypassed`, `identity`,
 *     `wrapped`, `off`) to render in the badge tooltip.
 *
 * The two were previously open-coded twice in `sandbox.ts` with
 * subtly diverging precedence. Centralising the ladder here keeps
 * the hook decision and the user-facing badge in lockstep.
 *
 * Pure module: pi-free (no `@earendil-works/*` imports). The only
 * runtime dependency is `parse-env.ts`'s `envTruthy` and the
 * `SandboxPlatformInfo` shape from `platform.ts`. Unit-tested under
 * `tests/lib/node/pi/sandbox/plan.spec.ts`.
 */

import { envTruthy } from '../parse-env.ts';
import { type SandboxPlatformInfo } from './platform.ts';

/** Five-way badge state shared with `lib/node/pi/session-flags.ts`'s
 *  `SandboxMode`. Re-declared here to avoid a circular import; the
 *  literal-union shape matches `session-flags.ts`. */
export type SandboxModeName = 'off' | 'env-disabled' | 'bypassed' | 'identity' | 'wrapped';

/** Inputs the planner reads from the live `RuntimeState`. Narrowed
 *  to the four fields that matter so the planner doesn't drag the
 *  full state shape into lib. */
export interface PlanInputs {
  /** Detected platform info; recomputed on `/sandbox-recheck`. */
  platform: SandboxPlatformInfo;
  /** Session-only bypass toggled by `/sandbox-disable`. */
  bypassed: boolean;
  /** Manager `initialize()` returned successfully. Only consumed by
   *  {@link resolveSandboxMode}; the wrap planner doesn't care. */
  initialized: boolean;
  /** Reason string surfaced in the statusline tooltip (latest). */
  reason?: string;
}

/** Discriminated union returned by {@link resolveWrapPlan}. */
export type WrapPlan = { kind: 'identity'; reason?: string } | { kind: 'wrapped' } | { kind: 'block'; reason: string };

/**
 * Resolve which mode the bash hook should take for the next wrap
 * call. The precedence ladder:
 *
 *   1. `PI_SANDBOX_DISABLED` truthy        → `identity`
 *   2. session bypass active               → `identity`
 *   3. platform `unsupported`              → `identity`
 *   4. platform reports missing deps       → `identity`
 *   5. running as root + no override       → `identity`
 *   6. otherwise                           → `wrapped`
 *
 * `kind: 'block'` is reserved for downstream wrap-failure handling
 * under `PI_SANDBOX_DEFAULT=block`; this resolver itself never
 * returns `block` because it only inspects pre-wrap state.
 */
export function resolveWrapPlan(inputs: PlanInputs): WrapPlan {
  if (envTruthy(process.env.PI_SANDBOX_DISABLED)) return { kind: 'identity', reason: 'PI_SANDBOX_DISABLED=1' };
  if (inputs.bypassed) return { kind: 'identity', reason: '/sandbox-disable' };
  if (inputs.platform.kind === 'unsupported') return { kind: 'identity', reason: inputs.platform.description };
  if (inputs.platform.missingDeps.length > 0) {
    return { kind: 'identity', reason: `missing deps: ${inputs.platform.missingDeps.join(', ')}` };
  }
  if (inputs.platform.isRoot && !envTruthy(process.env.PI_SANDBOX_ALLOW_ROOT)) {
    return { kind: 'identity', reason: 'running as root' };
  }
  return { kind: 'wrapped' };
}

/**
 * Resolve which statusline-mode + tooltip-reason the badge should
 * render. Same precedence ladder as {@link resolveWrapPlan}, plus
 * one extra rule: when the planner says `wrapped` but the manager
 * hasn't initialized yet, the badge says `wrapped` with reason
 * `"pending first bash"`.
 */
export function resolveSandboxMode(inputs: PlanInputs): { mode: SandboxModeName; reason?: string } {
  if (envTruthy(process.env.PI_SANDBOX_DISABLED)) return { mode: 'env-disabled', reason: 'PI_SANDBOX_DISABLED=1' };
  if (inputs.bypassed) return { mode: 'bypassed', reason: inputs.reason ?? '/sandbox-disable' };
  if (inputs.platform.kind === 'unsupported') {
    return { mode: 'identity', reason: inputs.platform.description };
  }
  if (inputs.platform.missingDeps.length > 0) {
    return { mode: 'identity', reason: `missing deps: ${inputs.platform.missingDeps.join(', ')}` };
  }
  if (inputs.platform.isRoot && !envTruthy(process.env.PI_SANDBOX_ALLOW_ROOT)) {
    return { mode: 'identity', reason: 'running as root (set PI_SANDBOX_ALLOW_ROOT=1 to override)' };
  }
  return inputs.initialized ? { mode: 'wrapped' } : { mode: 'wrapped', reason: 'pending first bash' };
}
