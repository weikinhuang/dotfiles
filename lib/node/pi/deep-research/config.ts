/**
 * Pure config defaults + coercion + layering for the `deep-research`
 * extension.
 *
 * The `research` tool / `/research` command already accept a rich
 * {@link ResearchOverrides} bundle per call (parent + per-agent model,
 * fanout / critic maxTurns, fanout parallelism, wall-clock). Those are
 * per-call knobs; this module lets the same fields be pinned as
 * per-project (`<cwd>/.pi/deep-research.json`) and per-user
 * (`<piAgentDir>/deep-research.json`) DEFAULTS so a project that always
 * fans out to a cheap local model doesn't have to pass the override
 * every call.
 *
 * deep-research has no per-param env knobs today (only
 * `PI_DEEP_RESEARCH_DISABLED`), so the layering is config-file-only:
 * built-in (empty) -> user config -> project config, with the per-call
 * override winning over all of them.
 *
 * Each layer is validated through {@link validateToolOverrides} (the
 * same validator the tool surface uses) so a bad value in a config file
 * degrades to "field absent" with a warning rather than poisoning a run.
 *
 * {@link loadDeepResearchConfig} does the disk wiring; reads go through
 * {@link readJsonOrUndefined}. No pi imports - unit-tested under vitest.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { type ResearchOverrides } from '../research/command-args.ts';
import { validateToolOverrides } from '../research/tool-overrides.ts';

/** A single rejected config field, surfaced via `ctx.ui.notify`. */
export interface DeepResearchConfigWarning {
  path: string;
  error: string;
}

export interface DeepResearchConfigResult {
  /** Validated default overrides (empty when no file pins any). */
  defaults: ResearchOverrides;
  warnings: DeepResearchConfigWarning[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one parsed JSON layer into a `ResearchOverrides`, pushing a
 * warning (and dropping the whole layer) when any field is malformed.
 * Reuses {@link validateToolOverrides} so the accepted values match the
 * tool / slash-command surface exactly. A non-object layer is ignored.
 */
export function coerceDeepResearchConfigLayer(
  raw: unknown,
  path: string,
  warnings: DeepResearchConfigWarning[],
): ResearchOverrides {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    warnings.push({ path, error: 'config must be a JSON object' });
    return {};
  }
  const result = validateToolOverrides(raw);
  if (!result.ok) {
    warnings.push({ path, error: result.error });
    return {};
  }
  return result.overrides;
}

/**
 * Layer `overrides` (lowest first). Every field is replaced wholesale by
 * a layer that sets it, so a project config can override a single
 * default (e.g. `fanoutModel`) on top of a user one.
 */
export function mergeDeepResearchConfigLayers(...layers: ResearchOverrides[]): ResearchOverrides {
  const result: ResearchOverrides = {};
  for (const layer of layers) {
    if (layer.model !== undefined) result.model = layer.model;
    if (layer.planCritModel !== undefined) result.planCritModel = layer.planCritModel;
    if (layer.fanoutModel !== undefined) result.fanoutModel = layer.fanoutModel;
    if (layer.criticModel !== undefined) result.criticModel = layer.criticModel;
    if (layer.fanoutMaxTurns !== undefined) result.fanoutMaxTurns = layer.fanoutMaxTurns;
    if (layer.criticMaxTurns !== undefined) result.criticMaxTurns = layer.criticMaxTurns;
    if (layer.reviewMaxIter !== undefined) result.reviewMaxIter = layer.reviewMaxIter;
    if (layer.fanoutParallel !== undefined) result.fanoutParallel = layer.fanoutParallel;
    if (layer.wallClockSec !== undefined) result.wallClockSec = layer.wallClockSec;
  }
  return result;
}

/**
 * Merge per-call overrides over the config-file defaults. A field set on
 * the call wins; otherwise the config default applies. This is the
 * `param ?? config` step the extension runs before handing the bundle to
 * the pipeline.
 */
export function applyDeepResearchDefaults(defaults: ResearchOverrides, perCall: ResearchOverrides): ResearchOverrides {
  return mergeDeepResearchConfigLayers(defaults, perCall);
}

/**
 * Load the default overrides for `cwd`, layering the user-global
 * `<piAgentDir>/deep-research.json` (lowest) under the project-local
 * `<cwd>/.pi/deep-research.json` (highest). Missing / malformed files
 * degrade to an empty defaults bundle plus a warning.
 */
export function loadDeepResearchConfig(cwd: string): DeepResearchConfigResult {
  const warnings: DeepResearchConfigWarning[] = [];
  const userPath = piAgentPath('deep-research.json');
  const projectPath = piProjectPath(cwd, 'deep-research.json');
  const userLayer = coerceDeepResearchConfigLayer(readJsonOrUndefined(userPath), userPath, warnings);
  const projectLayer = coerceDeepResearchConfigLayer(readJsonOrUndefined(projectPath), projectPath, warnings);
  return { defaults: mergeDeepResearchConfigLayers(userLayer, projectLayer), warnings };
}
