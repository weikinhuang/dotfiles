/**
 * `decision-model.json` loader, shared by the pi and opencode adapters.
 * Each harness reads the same JSONC shape from its own config dir
 * (`~/.pi/agent/decision-model.json`, `~/.config/opencode/decision-model.json`).
 *
 * User scope only, by design: a project-level file could point the gate
 * at an endpoint that approves everything, so a cloned repo must never be
 * able to configure it.
 *
 * The API key comes from the env var named by `provider.apiKeyEnv` when
 * it has a value, else from a literal `provider.apiKey`. Any problem (missing file, `enabled: false`, missing
 * URL / model / key, malformed values) yields an inactive config plus a
 * warning, and the adapters keep their normal behavior.
 *
 * Pure module apart from the file read; no harness imports.
 */

import { dirname, isAbsolute, join } from 'node:path';

import { type ConfigWarning, tryReadJsoncFile } from '../pi/jsonc.ts';
import { expandTilde } from '../pi/path-expand.ts';
import { type SystemOneEndpoint, systemOneUrl } from './system-one.ts';

export const DECISION_MODEL_CONFIG_FILE = 'decision-model.json';
export const DECISION_MODEL_LOG_FILE = 'decision-model.jsonl';

/** Shell command effect classes the decision model chooses between. */
export const SHELL_EFFECTS = [
  'read_only',
  'workspace_write',
  'outside_write',
  'network_write',
  'destructive',
  'opaque',
] as const;
export type ShellEffect = (typeof SHELL_EFFECTS)[number];

export interface ShellPolicy {
  enabled: boolean;
  /** Effect classes that may auto-allow. */
  allowEffects: ShellEffect[];
  /** Probability mass the allowed effects need, combined. */
  threshold: number;
  /** Highest acceptable probability for each yes/no risk flag. */
  maxRisk: number;
}

export interface DecisionModelConfig {
  endpoint: SystemOneEndpoint;
  model: string;
  /** Host only, for logs; never the key or path. */
  providerLabel: string;
  /** Largest serialized state sent; bigger inputs are not sent at all. */
  maxStateChars: number;
  /** JSONL log path, or `undefined` when logging is off. */
  logPath?: string;
  shell: ShellPolicy;
}

export type DecisionModelStatus =
  | { state: 'missing' }
  | { state: 'disabled' }
  | { state: 'invalid'; error: string }
  | { state: 'ready'; config: DecisionModelConfig };

export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_STATE_CHARS = 4000;
export const DEFAULT_SHELL_POLICY: ShellPolicy = {
  enabled: true,
  allowEffects: ['read_only', 'workspace_write'],
  threshold: 0.9,
  maxRisk: 0.1,
};

type EnvBag = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function unitOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function parseShellPolicy(raw: unknown, warnings: string[]): ShellPolicy {
  if (raw === undefined) return { ...DEFAULT_SHELL_POLICY, allowEffects: [...DEFAULT_SHELL_POLICY.allowEffects] };
  if (!isRecord(raw)) {
    warnings.push('"shell" must be an object; using defaults');
    return { ...DEFAULT_SHELL_POLICY, allowEffects: [...DEFAULT_SHELL_POLICY.allowEffects] };
  }
  let allowEffects = [...DEFAULT_SHELL_POLICY.allowEffects];
  if (raw.allowEffects !== undefined) {
    const list = Array.isArray(raw.allowEffects) ? (raw.allowEffects as unknown[]) : [];
    const known = list.filter((e): e is ShellEffect => SHELL_EFFECTS.includes(e as ShellEffect));
    const unknown = list.filter((e) => !SHELL_EFFECTS.includes(e as ShellEffect));
    if (unknown.length > 0 || !Array.isArray(raw.allowEffects)) {
      warnings.push(`"shell.allowEffects" ignores unknown entries; valid: ${SHELL_EFFECTS.join(', ')}`);
    }
    allowEffects = known;
  }
  return {
    enabled: raw.enabled !== false,
    allowEffects,
    threshold: unitOr(raw.threshold, DEFAULT_SHELL_POLICY.threshold),
    maxRisk: unitOr(raw.maxRisk, DEFAULT_SHELL_POLICY.maxRisk),
  };
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Resolve a `log` path: `~` expands, a relative path is relative to the config file. */
function resolveLogPath(raw: unknown, configPath: string, defaultLogPath: string, home: string): string | undefined {
  if (raw === false) return undefined;
  if (raw === undefined || raw === true) return defaultLogPath;
  const path = nonEmpty(raw);
  if (!path) return defaultLogPath;
  const expanded = expandTilde(path, home);
  return isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded);
}

export interface ResolveOptions {
  configPath: string;
  defaultLogPath: string;
  env: EnvBag;
  home: string;
}

/**
 * Turn a parsed config object into a status. `warnings` collects
 * non-fatal problems (ignored values that fell back to defaults).
 */
export function resolveDecisionModelConfig(
  raw: unknown,
  opts: ResolveOptions,
  warnings: string[] = [],
): DecisionModelStatus {
  if (raw === undefined) return { state: 'missing' };
  if (!isRecord(raw)) return { state: 'invalid', error: 'config root must be an object' };
  if (raw.enabled === false) return { state: 'disabled' };
  const provider = raw.provider;
  if (!isRecord(provider)) return { state: 'invalid', error: '"provider" is required' };

  const endpointOverride = nonEmpty(provider.endpoint);
  const baseUrl = nonEmpty(provider.baseUrl);
  if (!baseUrl && !endpointOverride) return { state: 'invalid', error: '"provider.baseUrl" is required' };
  const url = systemOneUrl(baseUrl ?? '', endpointOverride);
  const host = hostOf(url);
  if (!host) return { state: 'invalid', error: `invalid provider URL "${url}"` };

  const model = nonEmpty(provider.model);
  if (!model) return { state: 'invalid', error: '"provider.model" is required' };

  // The env var wins when it has a value; the literal key is the fallback.
  const keyEnv = nonEmpty(provider.apiKeyEnv);
  const apiKey = (keyEnv ? nonEmpty(opts.env[keyEnv]) : undefined) ?? nonEmpty(provider.apiKey);
  if (!apiKey) {
    return {
      state: 'invalid',
      error: keyEnv
        ? `API key env var ${keyEnv} is unset and no "provider.apiKey" is set`
        : 'set "provider.apiKey" or "provider.apiKeyEnv"',
    };
  }

  return {
    state: 'ready',
    config: {
      endpoint: {
        url,
        apiKey,
        headers: parseHeaders(provider.headers),
        timeoutMs: positiveInt(provider.timeoutMs, DEFAULT_TIMEOUT_MS),
      },
      model,
      providerLabel: host,
      maxStateChars: positiveInt(raw.maxStateChars, DEFAULT_MAX_STATE_CHARS),
      logPath: resolveLogPath(raw.log, opts.configPath, opts.defaultLogPath, opts.home),
      shell: parseShellPolicy(raw.shell, warnings),
    },
  };
}

/** Read and resolve `opts.configPath`. Missing file is `{ state: 'missing' }`. */
export function loadDecisionModelConfig(opts: ResolveOptions): { status: DecisionModelStatus; warnings: string[] } {
  const fileWarnings: ConfigWarning[] = [];
  const raw = tryReadJsoncFile(opts.configPath, fileWarnings, { requireObject: true });
  const warnings = fileWarnings.map((w) => w.error);
  if (raw === undefined && warnings.length > 0) {
    return { status: { state: 'invalid', error: warnings.join('; ') }, warnings: [] };
  }
  const status = resolveDecisionModelConfig(raw, opts, warnings);
  return { status, warnings };
}

/** One-line description for status commands; never includes the key. */
export function describeDecisionModelStatus(status: DecisionModelStatus, configPath: string): string {
  switch (status.state) {
    case 'missing':
      return `off (no ${configPath})`;
    case 'disabled':
      return `off ("enabled": false in ${configPath})`;
    case 'invalid':
      return `off (${configPath}: ${status.error})`;
    case 'ready': {
      const { config } = status;
      const shell = config.shell.enabled
        ? `shell auto-allow ${config.shell.allowEffects.join('+') || '(none)'} at p>=${config.shell.threshold}`
        : 'shell off';
      return `on (${config.providerLabel}, ${config.model}; ${shell})`;
    }
  }
}
