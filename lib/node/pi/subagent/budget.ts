/**
 * Resolve the effective maxTurns cap for one subagent dispatch.
 *
 * Pure module - no pi imports - so it can be unit-tested under
 * vitest. The extension at config/pi/extensions/subagent.ts is the
 * only consumer; see plans/pi-subagent-overrides.md for the design.
 *
 * Resolution semantics (per plan D3): the per-call override (if
 * present) replaces the agent default, and the env-var ceiling
 * (typically PI_SUBAGENT_MAX_TURNS) always wins. The agent default
 * therefore acts as a hint the override can lift, and the env var
 * remains the operator brake even when the model raises per-call.
 */

export interface MaxTurnsInputs {
  /** Per-call override (from the subagent tool's `maxTurns` field). */
  override: number | undefined;
  /** Default from the agent .md frontmatter (always present). */
  agentDefault: number;
  /** Global ceiling from PI_SUBAGENT_MAX_TURNS, or Number.MAX_SAFE_INTEGER if unset. */
  envCap: number;
}

export function resolveMaxTurns(inputs: MaxTurnsInputs): number {
  const requested = inputs.override ?? inputs.agentDefault;
  return Math.min(requested, inputs.envCap);
}

export interface TimeoutInputs {
  /** Per-call override (from the subagent tool's `timeoutMs` field). */
  override: number | undefined;
  /** Default from the agent .md frontmatter (always present). */
  agentDefault: number;
  /** Ceiling on a per-call override (config `maxTimeoutMs`). */
  maxTimeoutMs: number;
  /** Global hard cap from PI_SUBAGENT_TIMEOUT_MS, or Number.MAX_SAFE_INTEGER if unset. */
  hardCap: number;
}

export interface ResolvedTimeout {
  timeoutMs: number;
  /** The per-call override exceeded `maxTimeoutMs` and was lowered to it. */
  clampedToCeiling: boolean;
}

/**
 * Resolve the effective wall-clock cap for one subagent dispatch.
 *
 * Precedence: per-call override > agent frontmatter default. A per-call
 * override is first clamped to `maxTimeoutMs` (it may lift the cap above
 * the agent default, but not without bound); the agent default itself is
 * not subject to that ceiling. `hardCap` (PI_SUBAGENT_TIMEOUT_MS) always
 * wins last, mirroring how PI_SUBAGENT_MAX_TURNS caps `resolveMaxTurns`.
 */
export function resolveTimeoutMs(inputs: TimeoutInputs): ResolvedTimeout {
  const { override, agentDefault, maxTimeoutMs, hardCap } = inputs;
  const clampedToCeiling = override !== undefined && override > maxTimeoutMs;
  const requested = override === undefined ? agentDefault : Math.min(override, maxTimeoutMs);
  return { timeoutMs: Math.min(requested, hardCap), clampedToCeiling };
}
