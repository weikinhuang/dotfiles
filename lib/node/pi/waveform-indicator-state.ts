/**
 * Persistent state for the waveform indicator.
 *
 * Stored as a JSON file at one of two layered paths, mirroring the
 * resolution `bash-permissions.json` already uses:
 *
 *   1. `<cwd>/.pi/waveform-indicator.json` - project-local override.
 *   2. `<piAgentDir>/waveform-indicator.json` - user-global default
 *      (`~/.pi/agent/waveform-indicator.json` by default; override
 *      via `PI_CODING_AGENT_DIR`).
 *
 * Pi has no generic settings store, so each extension that wants
 * persistence rolls its own tiny file under `.pi/`.
 *
 * File shape:
 *   {
 *     "mode": "scroll" | "spectrum" | "tokenrate" | "off" | "default",
 *     "dynamicLabel": {
 *       "enabled": false,
 *       "tinyModel": "openai/gpt-4o-mini",
 *       "persona": "daemon-waveform",
 *       "maxCallsPerSession": 20
 *     }
 *   }
 *
 * `mode` resolution order:
 *   1. `PI_WAVEFORM_INDICATOR_MODE` env var (when set to a known mode).
 *   2. The persisted file's `mode` field.
 *   3. Fallback `'scroll'`.
 *
 * `dynamicLabel` resolution + validation:
 *
 *   - `enabled` defaults to `false`. The `PI_WAVEFORM_DYNAMIC_LABEL`
 *     env var overrides the file (`=on` / `=off`); any other value is
 *     ignored and we fall through to the file.
 *   - `tinyModel` is two-stage-validated. Parse-fail at load time (e.g.
 *     `tinyModel: "garbage"` with no `/`) silently disables the feature
 *     for this session - {@link resolveDynamicLabelConfig} returns
 *     `enabled: false` even when the file said `enabled: true`, and
 *     emits a `warnings` entry the extension surfaces via
 *     `ctx.ui.notify`. Registry-miss at spawn time is a different
 *     beast and lives in the extension - this helper only handles the
 *     syntactic check.
 *   - `persona` defaults to `'daemon-waveform'` so a fresh dotfiles
 *     install gets a working voice without any config. Set to the empty
 *     string (`""`) to opt out of the persona overlay (neutral
 *     system prompt only). Unknown / malformed values fall back to
 *     `'daemon-waveform'`.
 *   - `maxCallsPerSession` defaults to 20. Non-positive / non-finite
 *     values fall back to the default.
 *
 * Env overrides (shell-local, never persisted):
 *
 *   - `PI_WAVEFORM_DYNAMIC_LABEL=on|off` - flip the `enabled` flag.
 *   - `PI_WAVEFORM_DYNAMIC_LABEL_MODEL=<provider/id>` - swap the
 *     resolved `tinyModel`. A malformed env value (no `/`) falls
 *     back to the file's `tinyModel` rather than disabling outright,
 *     so a typo in a shell-export doesn't silently turn the feature
 *     off when the file's value is fine.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from './atomic-write.ts';
import { parseModelSpec } from './btw.ts';
import { piAgentPath } from './pi-paths.ts';
import { isRecord } from './shared.ts';

/**
 * Layered path resolution. Returns the project-local path when the
 * file exists there, otherwise the user-global path under the pi
 * agent dir. The extension caller hands us `ctx.cwd`; tests inject
 * an explicit `cwd` + `agentDir` so a temp directory drives the
 * layer walk without leaning on `PI_CODING_AGENT_DIR`.
 */
export interface WaveformStatePathOpts {
  cwd: string;
  agentDir?: string;
}

export function resolveWaveformStatePath(opts: WaveformStatePathOpts): string {
  const projectPath = join(opts.cwd, '.pi', 'waveform-indicator.json');
  if (existsSync(projectPath)) return projectPath;
  return opts.agentDir !== undefined
    ? join(opts.agentDir, 'waveform-indicator.json')
    : piAgentPath('waveform-indicator.json');
}

export type WaveformMode = 'scroll' | 'spectrum' | 'tokenrate' | 'off' | 'default';

export const VALID_WAVEFORM_MODES: readonly WaveformMode[] = ['scroll', 'spectrum', 'tokenrate', 'off', 'default'];

export function isWaveformMode(value: unknown): value is WaveformMode {
  return typeof value === 'string' && (VALID_WAVEFORM_MODES as readonly string[]).includes(value);
}

/** Default persona name baked into the shipped catalog (`config/pi/personas/daemon-waveform.md`). */
export const DEFAULT_DYNAMIC_LABEL_PERSONA = 'daemon-waveform';
/** Per-session cap when the file omits `maxCallsPerSession`. */
export const DEFAULT_MAX_CALLS_PER_SESSION = 20;

/**
 * Resolved dynamic-label configuration. `tinyModel: null` when the
 * feature is disabled or the file's value failed syntactic parse;
 * the extension treats that the same as `enabled: false`.
 */
export interface DynamicLabelConfig {
  enabled: boolean;
  /**
   * Normalized `provider/modelId` string when valid, `null` when the
   * feature is disabled or `tinyModel` failed parse. The extension
   * still has to call `modelRegistry.find(...)` at spawn time to
   * confirm the model is registered (registry-miss is the second
   * validation stage, not this helper's job).
   */
  tinyModel: string | null;
  /**
   * Resolved persona name. Empty string means "opt out, neutral
   * system prompt only" - distinct from the default `'daemon-waveform'`.
   * The extension uses {@link DEFAULT_DYNAMIC_LABEL_PERSONA} for any
   * non-string / whitespace value.
   */
  persona: string;
  maxCallsPerSession: number;
}

export interface DynamicLabelResolution {
  config: DynamicLabelConfig;
  /**
   * Diagnostic warnings worth surfacing once via `ctx.ui.notify`.
   * Specifically: the parse-fail-at-load case for `tinyModel`. We do
   * NOT warn on missing-file or `enabled: false` - those are normal
   * states.
   */
  warnings: string[];
}

interface StateFile {
  mode: WaveformMode;
  dynamicLabel?: unknown;
}

/**
 * Strict provider/id parser. Delegates to {@link parseModelSpec}
 * (the same helper `research-tiny.ts` uses) so every setting that
 * resolves here goes through the same grammar.
 */
function parseTinyModelSpec(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return `${parsed.provider}/${parsed.modelId}`;
}

/**
 * Read the raw on-disk JSON. Returns `null` on missing / unreadable /
 * unparseable. Exposed (not exported) for {@link readWaveformState}
 * and {@link readDynamicLabelRaw} to share the same forgiving parser.
 */
function readRawState(path: string): { mode?: unknown; dynamicLabel?: unknown } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as { mode?: unknown; dynamicLabel?: unknown };
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the persisted mode from `path`. Returns undefined when the file
 * is missing, unreadable, unparseable, or contains an unknown mode.
 * Never throws - bad state is treated as "no preference set" so a
 * corrupted file doesn't break startup.
 */
export function readWaveformState(path: string): WaveformMode | undefined {
  const parsed = readRawState(path);
  if (parsed && isWaveformMode(parsed.mode)) {
    return parsed.mode;
  }
  return undefined;
}

/**
 * Read the persisted file and extract the `dynamicLabel` block raw,
 * for {@link resolveDynamicLabelConfig} to validate against env
 * overrides. Returns `undefined` when the file is missing / malformed
 * / lacks a `dynamicLabel` field.
 */
export function readDynamicLabelRaw(path: string): unknown {
  const parsed = readRawState(path);
  if (!parsed) return undefined;
  return parsed.dynamicLabel;
}

/**
 * Write the mode to `path`. Creates the parent directory if missing
 * and writes via the shared {@link atomicWriteFile} helper, so a
 * concurrent run can't observe a half-written file.
 *
 * Throws on permission errors or disk-full so the caller can surface
 * them to the user (a silent failure here would mean the persisted
 * preference quietly stops sticking).
 *
 * `dynamicLabel` is preserved when the existing file carries one -
 * `/waveform <mode>` updates only the mode field, not the dynamic
 * label config. A user editing `dynamicLabel` by hand keeps their
 * settings even after a `/waveform` command.
 */
export function writeWaveformState(path: string, mode: WaveformMode): void {
  const existing = readRawState(path);
  const data: StateFile = { mode };
  if (existing?.dynamicLabel !== undefined) {
    data.dynamicLabel = existing.dynamicLabel;
  }
  atomicWriteFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Delete the persisted state file. Silent when the file is already
 * missing; throws on other errors (permission denied, etc.).
 */
export function clearWaveformState(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

/**
 * Resolve the initial mode at session start. Order:
 *   1. `PI_WAVEFORM_INDICATOR_MODE` env var (must be a known mode).
 *   2. The persisted file's `mode` field.
 *   3. Fallback `'scroll'`.
 *
 * The `env` parameter is injected for testability; production callers
 * pass `process.env`.
 */
export function resolveInitialWaveformMode(filePath: string, env: NodeJS.ProcessEnv = process.env): WaveformMode {
  const fromEnv = env.PI_WAVEFORM_INDICATOR_MODE;
  if (fromEnv && isWaveformMode(fromEnv)) return fromEnv;
  return readWaveformState(filePath) ?? 'scroll';
}

// ──────────────────────────────────────────────────────────────────────
// dynamicLabel resolver
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the dynamic-label config from the persisted file plus env
 * overrides. Returns the merged config and any one-shot warnings the
 * extension should surface.
 *
 * Parse-fail semantics (the part the plan calls out as the
 * fallback-rules-differ case):
 *
 *   - File's `tinyModel` parses but env var's doesn't → use the
 *     file's value. The env-typo doesn't silently disable the feature.
 *   - File's `tinyModel` doesn't parse → return `enabled: false` even
 *     if `enabled: true` in the file. Emit a warning.
 *   - File's `tinyModel` parses but `enabled: false` (and no env opt-in)
 *     → return `enabled: false`, no warning.
 *   - File missing entirely → return `enabled: false`, no warning.
 *
 * Env precedence: `PI_WAVEFORM_DYNAMIC_LABEL` flips `enabled`,
 * `PI_WAVEFORM_DYNAMIC_LABEL_MODEL` substitutes `tinyModel` (when
 * the env value parses; otherwise falls through to the file).
 */
/**
 * Validate the file's `dynamicLabel` raw payload. Pure - the env-var
 * resolution happens in {@link resolveDynamicLabelConfig} after this.
 *
 * Returns the parsed config with `tinyModel: null` when the file's
 * value is missing or fails syntactic parse, plus any warnings.
 */
function readDynamicLabelFromFile(raw: unknown, warnings: string[]): DynamicLabelConfig {
  if (!isRecord(raw)) {
    return {
      enabled: false,
      tinyModel: null,
      persona: DEFAULT_DYNAMIC_LABEL_PERSONA,
      maxCallsPerSession: DEFAULT_MAX_CALLS_PER_SESSION,
    };
  }

  // enabled: default false when missing / non-bool.
  const enabledFile = raw.enabled === true;

  // tinyModel: required when enabled=true. Parse-fail → disable.
  let tinyModel: string | null = null;
  const tinyRaw = raw.tinyModel;
  if (typeof tinyRaw === 'string' && tinyRaw.trim().length > 0) {
    const parsed = parseTinyModelSpec(tinyRaw);
    if (parsed !== null) {
      tinyModel = parsed;
    } else {
      warnings.push(
        `waveform-indicator: dynamicLabel.tinyModel "${tinyRaw}" did not parse (expected provider/id); dynamic label disabled`,
      );
    }
  }
  // Enabled-but-no-tinyModel is a silent-disable per the plan; no
  // explicit branch needed.

  // persona: '' means opt-out; default to 'daemon-waveform' when missing.
  let persona = DEFAULT_DYNAMIC_LABEL_PERSONA;
  if (typeof raw.persona === 'string') {
    persona = raw.persona;
  }

  // maxCallsPerSession: default 20.
  let maxCalls = DEFAULT_MAX_CALLS_PER_SESSION;
  if (
    typeof raw.maxCallsPerSession === 'number' &&
    Number.isFinite(raw.maxCallsPerSession) &&
    raw.maxCallsPerSession > 0
  ) {
    maxCalls = Math.floor(raw.maxCallsPerSession);
  }

  return {
    enabled: enabledFile && tinyModel !== null,
    tinyModel,
    persona,
    maxCallsPerSession: maxCalls,
  };
}

export function resolveDynamicLabelConfig(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): DynamicLabelResolution {
  const warnings: string[] = [];
  const raw = readDynamicLabelRaw(filePath);

  const fromFile = readDynamicLabelFromFile(raw, warnings);

  // ── Env: enabled flip ────────────────────────────────────────────
  let enabled = fromFile.enabled;
  const rawEnabledEnv = env.PI_WAVEFORM_DYNAMIC_LABEL;
  if (typeof rawEnabledEnv === 'string') {
    const lower = rawEnabledEnv.toLowerCase();
    if (lower === 'on' || lower === '1' || lower === 'true') enabled = true;
    else if (lower === 'off' || lower === '0' || lower === 'false') enabled = false;
    // any other value: ignore, fall through to file value
  }

  // ── Env: tinyModel substitution ──────────────────────────────────
  let tinyModel = fromFile.tinyModel;
  const rawModelEnv = env.PI_WAVEFORM_DYNAMIC_LABEL_MODEL;
  if (typeof rawModelEnv === 'string' && rawModelEnv.trim().length > 0) {
    const envParsed = parseTinyModelSpec(rawModelEnv);
    if (envParsed !== null) {
      tinyModel = envParsed;
    }
    // env value doesn't parse → keep the file's value (which may be null);
    // the plan's "fall back to file" rule for malformed env values.
  }

  // Disable when no valid model is available, regardless of the
  // enabled flag (the two-stage validation contract).
  if (!tinyModel) enabled = false;

  return {
    config: {
      enabled,
      tinyModel,
      persona: fromFile.persona,
      maxCallsPerSession: fromFile.maxCallsPerSession,
    },
    warnings,
  };
}
