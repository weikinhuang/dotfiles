/**
 * Pure config defaults + coercion + layering for the `bg_bash` extension.
 *
 * Two kinds of knob live here:
 *
 *   1. Per-call tool-param defaults (`timeoutMs`, `stream`, `maxBytes`,
 *      `tail`): the fallback the handler uses when a `bg_bash` call omits
 *      the param. A project can pin e.g. a longer default `wait` timeout
 *      or always-tail `logs` without the model passing it every time.
 *   2. Operational knobs (`maxBufferBytes`, `killGraceMs`,
 *      `maxInjectedChars`) that previously read ONLY from `PI_BG_BASH_*`
 *      env vars. Those env vars are folded in here as the env layer, so a
 *      committed project / user config file now wins over a stray shell
 *      export.
 *
 * Resolution order (lowest -> highest): built-in default -> env knob ->
 * user global `<piAgentDir>/bg-bash.json` -> project local
 * `<cwd>/.pi/bg-bash.json`. The per-call tool param, when present, wins
 * over all of these (the handler does `params.X ?? config.X`).
 *
 * {@link loadBgBashConfig} does the disk wiring (read the user + project
 * JSON, coerce each, layer over the env + built-in base) so the
 * extension shell only does the `params.X ?? config.X` resolution. Reads
 * go through {@link readJsonOrUndefined} so a missing / malformed file
 * degrades to an empty layer rather than throwing.
 *
 * No pi imports - unit-tested under vitest.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

/** Which stream `logs` returns by default. */
export type BgBashStream = 'stdout' | 'stderr' | 'merged';

/** Fully-resolved `bg_bash` config (built-in + env + user + project). */
export interface BgBashConfig {
  /** Default `wait` timeout in ms when the call omits `timeoutMs`. */
  timeoutMs: number;
  /** Default `logs` stream when the call omits `stream`. */
  stream: BgBashStream;
  /** Default soft cap on `logs` response bytes when the call omits `maxBytes`. */
  maxBytes: number;
  /**
   * Default `logs` tail-line count when the call omits `tail`. Undefined
   * = no implicit tail (return the whole buffer up to `maxBytes`).
   */
  tail?: number;
  /** Per-stream ring-buffer cap (env: `PI_BG_BASH_MAX_BUFFER_BYTES`). */
  maxBufferBytes: number;
  /** SIGTERM->SIGKILL grace window on shutdown (env: `PI_BG_BASH_KILL_GRACE_MS`). */
  killGraceMs: number;
  /** Soft cap on the injected `## Background Jobs` block (env: `PI_BG_BASH_MAX_INJECTED_CHARS`). */
  maxInjectedChars: number;
  /**
   * Default `start` nudge flag when the call omits `nudge`. When true, a
   * job that finishes on its own sends an unsolicited completion message
   * (waking the agent when idle). Off by default - opt-in per call.
   */
  nudge: boolean;
}

/** Built-in defaults, used as the lowest config layer. */
export const DEFAULT_BG_BASH_CONFIG: BgBashConfig = {
  timeoutMs: 15_000,
  stream: 'merged',
  maxBytes: 32 * 1024,
  maxBufferBytes: 1024 * 1024,
  killGraceMs: 3000,
  maxInjectedChars: 1500,
  nudge: false,
};

/** Floors matching the prior `parseClampedPositiveInt` calls in the shell. */
const MAX_INJECTED_CHARS_FLOOR = 200;

const STREAMS = new Set<BgBashStream>(['stdout', 'stderr', 'merged']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse an env string to an integer, or undefined when missing / blank / non-numeric. */
function numFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function asIntAtLeast(value: unknown, min: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= min ? n : undefined;
}

function asStream(value: unknown): BgBashStream | undefined {
  return typeof value === 'string' && STREAMS.has(value as BgBashStream) ? (value as BgBashStream) : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Validate an untrusted parsed JSON layer into a `Partial<BgBashConfig>`,
 * dropping any field with the wrong type / out of range. Returns an empty
 * object for a non-object input.
 */
export function coerceBgBashConfigLayer(raw: unknown): Partial<BgBashConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<BgBashConfig> = {};

  const timeoutMs = asIntAtLeast(raw.timeoutMs, 0);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const stream = asStream(raw.stream);
  if (stream !== undefined) out.stream = stream;

  const maxBytes = asIntAtLeast(raw.maxBytes, 1);
  if (maxBytes !== undefined) out.maxBytes = maxBytes;

  const tail = asIntAtLeast(raw.tail, 0);
  if (tail !== undefined) out.tail = tail;

  const maxBufferBytes = asIntAtLeast(raw.maxBufferBytes, 0);
  if (maxBufferBytes !== undefined) out.maxBufferBytes = maxBufferBytes;

  const killGraceMs = asIntAtLeast(raw.killGraceMs, 0);
  if (killGraceMs !== undefined) out.killGraceMs = killGraceMs;

  const maxInjectedChars = asIntAtLeast(raw.maxInjectedChars, MAX_INJECTED_CHARS_FLOOR);
  if (maxInjectedChars !== undefined) out.maxInjectedChars = maxInjectedChars;

  const nudge = asBoolean(raw.nudge);
  if (nudge !== undefined) out.nudge = nudge;

  return out;
}

/**
 * Build the env layer from the existing `PI_BG_BASH_*` operational knobs.
 * Only the three knobs that predate the config file are read here; a
 * set-but-invalid value is dropped (falls through to the built-in),
 * matching the prior `parseClampedPositiveInt` floor behaviour. The
 * per-call defaults (`timeoutMs`, `stream`, `maxBytes`, `tail`) have no
 * env equivalent and are not read here.
 */
export function bgBashEnvLayer(env: NodeJS.ProcessEnv = process.env): Partial<BgBashConfig> {
  const out: Partial<BgBashConfig> = {};

  const maxBufferBytes = asIntAtLeast(numFromEnv(env.PI_BG_BASH_MAX_BUFFER_BYTES), 0);
  if (maxBufferBytes !== undefined) out.maxBufferBytes = maxBufferBytes;

  const killGraceMs = asIntAtLeast(numFromEnv(env.PI_BG_BASH_KILL_GRACE_MS), 0);
  if (killGraceMs !== undefined) out.killGraceMs = killGraceMs;

  const maxInjectedChars = asIntAtLeast(numFromEnv(env.PI_BG_BASH_MAX_INJECTED_CHARS), MAX_INJECTED_CHARS_FLOOR);
  if (maxInjectedChars !== undefined) out.maxInjectedChars = maxInjectedChars;

  return out;
}

/**
 * Layer `overrides` over {@link DEFAULT_BG_BASH_CONFIG} in priority order
 * (lowest first). Every field is replaced wholesale by a layer that sets
 * it; `tail` once set cannot be cleared back to "no tail" by a later
 * layer (a later layer can only change the count), which matches the
 * file-over-env-over-default intent.
 */
export function mergeBgBashConfigLayers(...overrides: Partial<BgBashConfig>[]): BgBashConfig {
  const result: BgBashConfig = { ...DEFAULT_BG_BASH_CONFIG };
  for (const layer of overrides) {
    if (layer.timeoutMs !== undefined) result.timeoutMs = layer.timeoutMs;
    if (layer.stream !== undefined) result.stream = layer.stream;
    if (layer.maxBytes !== undefined) result.maxBytes = layer.maxBytes;
    if (layer.tail !== undefined) result.tail = layer.tail;
    if (layer.maxBufferBytes !== undefined) result.maxBufferBytes = layer.maxBufferBytes;
    if (layer.killGraceMs !== undefined) result.killGraceMs = layer.killGraceMs;
    if (layer.maxInjectedChars !== undefined) result.maxInjectedChars = layer.maxInjectedChars;
    if (layer.nudge !== undefined) result.nudge = layer.nudge;
  }
  return result;
}

/**
 * Load the fully-resolved config for `cwd`, layering built-in defaults
 * (lowest) under the `PI_BG_BASH_*` env knobs, then the user-global
 * `<piAgentDir>/bg-bash.json`, then the project-local
 * `<cwd>/.pi/bg-bash.json` (highest). `env` is injectable for tests.
 */
export function loadBgBashConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): BgBashConfig {
  const envLayer = bgBashEnvLayer(env);
  const userLayer = coerceBgBashConfigLayer(readJsonOrUndefined(piAgentPath('bg-bash.json')));
  const projectLayer = coerceBgBashConfigLayer(readJsonOrUndefined(piProjectPath(cwd, 'bg-bash.json')));
  return mergeBgBashConfigLayers(envLayer, userLayer, projectLayer);
}
