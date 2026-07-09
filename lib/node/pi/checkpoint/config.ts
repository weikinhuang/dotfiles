/**
 * Pure config defaults + coercion + layering for the `checkpoint` extension.
 *
 * Mirrors `comfyui/config.ts`: the extension shell reads each JSON(C) layer
 * from disk, feeds it through {@link coerceConfigLayer} (untrusted `unknown`
 * → validated `Partial<CheckpointConfig>`), then {@link mergeConfigLayers}.
 * Validation + merge live here so they are unit-testable without the pi
 * runtime.
 *
 * Per-key precedence (lowest first):
 *   built-in default → env knob → user `<piAgentDir>/checkpoint.json` →
 *   project `<cwd>/.pi/checkpoint.json` → per-call
 * The nested `full` block is deep-merged so a higher layer can override one
 * full-mode cap without dropping the others.
 *
 * Env escape hatches (handled by the shell, surfaced here for documentation):
 *   PI_CHECKPOINT_DISABLED=1       disable the extension entirely
 *   PI_CHECKPOINT_DISABLE_FULL=1   force `mode: "tool"` regardless of config
 *
 * No pi imports.
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { isRecord } from '../shared/guards.ts';

/** What happens when navigation / fork lands on a point whose code differs. */
export type AutoReview = 'review' | 'auto' | 'off';

/** Snapshot strategy. */
export type CheckpointMode = 'tool' | 'full';

/** Full-mode (git side-dir) caps + confirmation. */
export interface FullModeConfig {
  maxStagedFiles: number;
  maxStagedBytes: number;
  confirmClean: boolean;
}

export interface CheckpointConfig {
  mode: CheckpointMode;
  autoReviewOnNavigate: AutoReview;
  reviewOnFork: boolean;
  hideNoOpRows: boolean;
  conflictRowsDefaultChecked: boolean;
  maxFileBytes: number;
  retentionDays: number;
  showOutOfSyncWidget: boolean;
  full: FullModeConfig;
}

/** Shipped defaults - the lowest config layer. Mirrors `checkpoint-example.json`. */
export const DEFAULT_CONFIG: CheckpointConfig = {
  mode: 'tool',
  autoReviewOnNavigate: 'review',
  reviewOnFork: true,
  hideNoOpRows: true,
  conflictRowsDefaultChecked: false,
  maxFileBytes: 5_242_880, // 5 MB
  retentionDays: 30,
  showOutOfSyncWidget: true,
  full: {
    maxStagedFiles: 5000,
    maxStagedBytes: 268_435_456, // 256 MB
    confirmClean: true,
  },
};

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Finite number ≥ 0 (retentionDays accepts 0 = keep forever). */
function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Finite number > 0 (size / file caps must be positive to mean anything). */
function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asMode(value: unknown): CheckpointMode | undefined {
  return value === 'tool' || value === 'full' ? value : undefined;
}

function asAutoReview(value: unknown): AutoReview | undefined {
  return value === 'review' || value === 'auto' || value === 'off' ? value : undefined;
}

/** Validate the optional nested `full` block, dropping wrong-typed fields. */
function asFullLayer(value: unknown): Partial<FullModeConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<FullModeConfig> = {};
  const maxStagedFiles = asPositiveNumber(value.maxStagedFiles);
  if (maxStagedFiles !== undefined) out.maxStagedFiles = maxStagedFiles;
  const maxStagedBytes = asPositiveNumber(value.maxStagedBytes);
  if (maxStagedBytes !== undefined) out.maxStagedBytes = maxStagedBytes;
  const confirmClean = asBoolean(value.confirmClean);
  if (confirmClean !== undefined) out.confirmClean = confirmClean;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One coerced layer: scalars at the top, `full` partially-merged. */
export interface CheckpointConfigLayer {
  mode?: CheckpointMode;
  autoReviewOnNavigate?: AutoReview;
  reviewOnFork?: boolean;
  hideNoOpRows?: boolean;
  conflictRowsDefaultChecked?: boolean;
  maxFileBytes?: number;
  retentionDays?: number;
  showOutOfSyncWidget?: boolean;
  full?: Partial<FullModeConfig>;
}

/**
 * Validate an untrusted parsed JSON layer into a {@link CheckpointConfigLayer},
 * dropping any field with the wrong type. Returns an empty object for a
 * non-object input. Unknown keys are ignored (the shell may `console.warn`).
 */
export function coerceConfigLayer(raw: unknown): CheckpointConfigLayer {
  if (!isRecord(raw)) return {};
  const out: CheckpointConfigLayer = {};

  const mode = asMode(raw.mode);
  if (mode !== undefined) out.mode = mode;

  const autoReviewOnNavigate = asAutoReview(raw.autoReviewOnNavigate);
  if (autoReviewOnNavigate !== undefined) out.autoReviewOnNavigate = autoReviewOnNavigate;

  const reviewOnFork = asBoolean(raw.reviewOnFork);
  if (reviewOnFork !== undefined) out.reviewOnFork = reviewOnFork;

  const hideNoOpRows = asBoolean(raw.hideNoOpRows);
  if (hideNoOpRows !== undefined) out.hideNoOpRows = hideNoOpRows;

  const conflictRowsDefaultChecked = asBoolean(raw.conflictRowsDefaultChecked);
  if (conflictRowsDefaultChecked !== undefined) out.conflictRowsDefaultChecked = conflictRowsDefaultChecked;

  const maxFileBytes = asPositiveNumber(raw.maxFileBytes);
  if (maxFileBytes !== undefined) out.maxFileBytes = maxFileBytes;

  const retentionDays = asNonNegativeNumber(raw.retentionDays);
  if (retentionDays !== undefined) out.retentionDays = retentionDays;

  const showOutOfSyncWidget = asBoolean(raw.showOutOfSyncWidget);
  if (showOutOfSyncWidget !== undefined) out.showOutOfSyncWidget = showOutOfSyncWidget;

  const full = asFullLayer(raw.full);
  if (full !== undefined) out.full = full;

  return out;
}

/**
 * Layer `overrides` over {@link DEFAULT_CONFIG} in priority order (lowest
 * first). Scalars are replaced wholesale; the nested `full` block merges by
 * field so a higher layer can override one cap without dropping the others.
 */
export function mergeConfigLayers(...overrides: CheckpointConfigLayer[]): CheckpointConfig {
  const result: CheckpointConfig = { ...DEFAULT_CONFIG, full: { ...DEFAULT_CONFIG.full } };

  for (const layer of overrides) {
    if (layer.mode !== undefined) result.mode = layer.mode;
    if (layer.autoReviewOnNavigate !== undefined) result.autoReviewOnNavigate = layer.autoReviewOnNavigate;
    if (layer.reviewOnFork !== undefined) result.reviewOnFork = layer.reviewOnFork;
    if (layer.hideNoOpRows !== undefined) result.hideNoOpRows = layer.hideNoOpRows;
    if (layer.conflictRowsDefaultChecked !== undefined) {
      result.conflictRowsDefaultChecked = layer.conflictRowsDefaultChecked;
    }
    if (layer.maxFileBytes !== undefined) result.maxFileBytes = layer.maxFileBytes;
    if (layer.retentionDays !== undefined) result.retentionDays = layer.retentionDays;
    if (layer.showOutOfSyncWidget !== undefined) result.showOutOfSyncWidget = layer.showOutOfSyncWidget;
    if (layer.full !== undefined) result.full = { ...result.full, ...layer.full };
  }

  return result;
}

/**
 * Resolve the env-derived layer. Only the `PI_CHECKPOINT_DISABLE_FULL` force
 * lives here (forces `mode: "tool"`); the `PI_CHECKPOINT_DISABLED` whole-
 * extension switch is handled by the shell before any config is read.
 *
 * `disableFull` is injectable so vitest can pin it without touching the host
 * environment.
 */
export function envConfigLayer(disableFull: boolean): CheckpointConfigLayer {
  return disableFull ? { mode: 'tool' } : {};
}

/**
 * Load the fully-resolved config for `cwd`, layering env (lowest above the
 * built-in default) under the user-global `<piAgentDir>/checkpoint.json` and
 * the project-local `<cwd>/.pi/checkpoint.json`. Missing / malformed files
 * degrade to an empty layer (defaults win) via {@link readJsoncOrUndefined}.
 */
export function loadCheckpointConfig(cwd: string, disableFull: boolean): CheckpointConfig {
  const envLayer = envConfigLayer(disableFull);
  const userLayer = coerceConfigLayer(readJsoncOrUndefined(piAgentPath('checkpoint.json')));
  const projectLayer = coerceConfigLayer(readJsoncOrUndefined(piProjectPath(cwd, 'checkpoint.json')));
  // env sits below the config files so a committed project config wins over a
  // stray shell export, but PI_CHECKPOINT_DISABLE_FULL is re-applied last as a
  // hard force so it can't be overridden back to "full" by a config file.
  const merged = mergeConfigLayers(envLayer, userLayer, projectLayer);
  if (disableFull) merged.mode = 'tool';
  return merged;
}
