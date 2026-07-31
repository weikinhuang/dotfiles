/**
 * Main-agent usage-guidance resolver for the `comfyui` extension.
 *
 * Unlike the enhancer / refiner guidance (which feed their subagents in a
 * separate context window), this block is injected into the MAIN agent's
 * system prompt at `before_agent_start`. A token-constrained local model
 * will not pull a lazily-referenced skill on its own, so guidance on how to
 * drive `generate_image` has to be eager and in-prompt.
 *
 * Two overridable files, selected by whether prompt enhancement is
 * effectively active this session:
 *
 *   - not active -> {@link ComfyuiConfig.usageGuidanceFile}: the main model
 *     writes the final prompt itself, so it needs the full protocol.
 *   - active     -> {@link ComfyuiConfig.usageGuidanceEnhancedFile}: the
 *     enhancer subagent crafts the prompt, so the main block can shrink and
 *     the heavy protocol lives in the enhancer's own guidance instead of
 *     the hot main context.
 *
 * "Effectively active" = the caller's `enhanceAvailable` (enhancer agent
 * installed + not env-disabled) AND the default enhance state for the
 * default workflow (`workflow.enhance ?? config.enhance`), mirroring the
 * executor's own `params.enhance ?? wf.enhance ?? config.enhance`
 * resolution (the per-call `params.enhance` is unknowable before a tool
 * call, and is the model's to override then). Availability has to gate it:
 * when `config.enhance` is on but no enhancer is installed, enhancement
 * silently no-ops and the main model still writes the prompt, so it needs
 * the base file, not the enhanced one.
 *
 * Both paths resolve like a workflow `file` via {@link readGuidanceFiles}
 * and flow through the config cascade. The applicable file being unset /
 * missing / empty resolves to `''` so the caller injects nothing
 * (byte-identical to no guidance). The `PI_COMFYUI_DISABLE_USAGE_GUIDANCE`
 * kill switch forces `''` regardless of config - a one-flag way to A/B a
 * custom block against stock, and a safety hatch. Never throws.
 *
 * Lives under `ext/` (it reaches the fs through {@link readGuidanceFiles}),
 * no pi runtime, so it stays unit-testable without the pi harness.
 */

import { envTruthy } from '../../parse-env.ts';
import type { ComfyuiConfig } from '../../comfyui/types.ts';
import { readGuidanceFiles } from './guidance.ts';

export interface ResolveUsageGuidanceOpts {
  config: ComfyuiConfig;
  /**
   * Whether the enhancer can actually run this session: agent installed and
   * not env-disabled. Computed by the caller (it needs the pi-coupled
   * enhancer access + `PI_COMFYUI_DISABLE_ENHANCE`). Gates the enhanced
   * variant so it is never shown when enhancement would no-op.
   */
  enhanceAvailable: boolean;
  /** Directory relative paths resolve against (the live session cwd). */
  fromCwd: string;
}

/**
 * The default enhance state for the default workflow, mirroring the
 * executor's `wf.enhance ?? config.enhance`. A `defaultWorkflow` that does
 * not name a configured workflow (config is not validated for this) falls
 * back to the global `config.enhance`.
 */
function enhanceDefault(config: ComfyuiConfig): boolean {
  const wf = config.workflows[config.defaultWorkflow];
  if (!wf) return config.enhance;
  return wf.enhance ?? config.enhance;
}

/**
 * The main-agent usage-guidance block for the current session, or `''` when
 * `PI_COMFYUI_DISABLE_USAGE_GUIDANCE` is set or the applicable file is unset
 * / missing / empty. Picks `usageGuidanceEnhancedFile` when enhancement is
 * effectively active for the default workflow, else `usageGuidanceFile`.
 */
export function resolveUsageGuidance(opts: ResolveUsageGuidanceOpts): string {
  if (envTruthy(process.env.PI_COMFYUI_DISABLE_USAGE_GUIDANCE)) return '';
  const { config, enhanceAvailable, fromCwd } = opts;
  const enhanceActive = enhanceAvailable && enhanceDefault(config);
  const file = enhanceActive ? config.usageGuidanceEnhancedFile : config.usageGuidanceFile;
  return readGuidanceFiles([file], fromCwd);
}
