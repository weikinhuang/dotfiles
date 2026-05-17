/**
 * Persistent state for the waveform indicator.
 *
 * Stored as a single-key JSON file at `~/.pi/waveform-indicator.json`,
 * matching the layout pattern used by `bash-permissions.json`. Pi has no
 * generic settings store, so each extension that wants persistence rolls
 * its own tiny file under `~/.pi/`.
 *
 * File shape:
 *   {
 *     "mode": "scroll" | "spectrum" | "off" | "default"
 *   }
 *
 * The lookup order at startup is:
 *   1. `PI_WAVEFORM_INDICATOR_MODE` env var (when set to a known mode).
 *   2. The persisted file's `mode` field.
 *   3. Fallback `'scroll'`.
 *
 * The env var winning over the file lets users override the persisted
 * default for a single shell without rewriting the file - same shape as
 * `PI_WAVEFORM_INDICATOR_DISABLED`.
 */

import { readFileSync, unlinkSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';

export type WaveformMode = 'scroll' | 'spectrum' | 'off' | 'default';

export const VALID_WAVEFORM_MODES: readonly WaveformMode[] = ['scroll', 'spectrum', 'off', 'default'];

export function isWaveformMode(value: unknown): value is WaveformMode {
  return typeof value === 'string' && (VALID_WAVEFORM_MODES as readonly string[]).includes(value);
}

interface StateFile {
  mode: WaveformMode;
}

/**
 * Read the persisted mode from `path`. Returns undefined when the file
 * is missing, unreadable, unparseable, or contains an unknown mode.
 * Never throws - bad state is treated as "no preference set" so a
 * corrupted file doesn't break startup.
 */
export function readWaveformState(path: string): WaveformMode | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === 'object' && isWaveformMode((parsed as StateFile).mode)) {
    return (parsed as StateFile).mode;
  }
  return undefined;
}

/**
 * Write the mode to `path`. Creates the parent directory if missing
 * and writes via the shared {@link atomicWriteFile} helper, so a
 * concurrent run can't observe a half-written file.
 *
 * Throws on permission errors or disk-full so the caller can surface
 * them to the user (a silent failure here would mean the persisted
 * preference quietly stops sticking).
 */
export function writeWaveformState(path: string, mode: WaveformMode): void {
  const data: StateFile = { mode };
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
