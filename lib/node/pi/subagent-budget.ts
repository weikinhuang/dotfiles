/**
 * Resolve the effective maxTurns cap for one subagent dispatch.
 *
 * Pure module — no pi imports — so it can be unit-tested under
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
