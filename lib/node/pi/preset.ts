/**
 * Pure helpers for the preset extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * A "preset" is a named bundle that configures the model, thinking
 * level, active tool set, and an optional appended system-prompt
 * snippet. Presets are loaded from three layered JSONC files:
 *
 *   1. Dotfiles-shipped defaults at `config/pi/presets.json`.
 *   2. User-global overrides at `~/.pi/agent/presets.json`.
 *   3. Project-local overrides at `<cwd>/.pi/presets.json`.
 *
 * Later layers override earlier ones by preset NAME (not by field).
 * A user who wants to tweak one knob of a shipped preset should copy
 * the whole preset object to their user / project file and change the
 * one knob there.
 */

import { readFileSync } from 'node:fs';

import { parseJsonc } from './jsonc.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface Preset {
  /** `provider/modelId` form. Optional — preset may toggle only thinking / tools / prompt. */
  model?: string;
  /** Thinking level. Validated against `THINKING_LEVELS` at load time. */
  thinkingLevel?: ThinkingLevel;
  /** Active tool allow-list. Replaces the current set when the preset activates. */
  tools?: string[];
  /** Appended to the system prompt while this preset is active. */
  appendSystemPrompt?: string;
}

export type PresetsConfig = Record<string, Preset>;

export interface PresetWarning {
  path: string;
  error: string;
}

export interface LoadResult {
  presets: PresetsConfig;
  /** Names in priority (highest wins) order — useful for deterministic listing. */
  nameOrder: string[];
  warnings: PresetWarning[];
}

/**
 * Check a candidate preset object; drop unknown keys and validate
 * the known ones. Returns `undefined` when the entry is completely
 * unusable; `warnings` accumulates per-issue diagnostics keyed to the
 * source file path.
 */
export function normalizePreset(
  path: string,
  name: string,
  raw: unknown,
  warnings: PresetWarning[],
): Preset | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ path, error: `preset "${name}" is not an object` });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: Preset = {};
  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string' || !obj.model.trim()) {
      warnings.push({ path, error: `preset "${name}" has invalid model (must be non-empty string)` });
    } else {
      out.model = obj.model.trim();
    }
  }
  if (obj.thinkingLevel !== undefined) {
    if (typeof obj.thinkingLevel !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(obj.thinkingLevel)) {
      warnings.push({
        path,
        error: `preset "${name}" has invalid thinkingLevel (must be one of: ${THINKING_LEVELS.join(', ')})`,
      });
    } else {
      out.thinkingLevel = obj.thinkingLevel as ThinkingLevel;
    }
  }
  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) {
      warnings.push({ path, error: `preset "${name}" has invalid tools (must be an array of strings)` });
    } else {
      const tools = obj.tools.filter((t): t is string => typeof t === 'string' && t.length > 0);
      if (tools.length > 0) out.tools = tools;
    }
  }
  if (obj.appendSystemPrompt !== undefined) {
    if (typeof obj.appendSystemPrompt !== 'string') {
      warnings.push({ path, error: `preset "${name}" has invalid appendSystemPrompt (must be a string)` });
    } else if (obj.appendSystemPrompt.trim().length > 0) {
      out.appendSystemPrompt = obj.appendSystemPrompt;
    }
  }
  return out;
}

/**
 * Load presets from multiple JSONC files in priority order (lowest
 * first). Missing files are silent; malformed JSON or bad entries
 * produce structured warnings the caller surfaces to the user.
 *
 * File reader is injected so callers / tests can swap in in-memory
 * content without hitting the filesystem.
 */
export function loadPresetFiles(paths: readonly string[], readFile: (path: string) => string | undefined): LoadResult {
  const warnings: PresetWarning[] = [];
  const merged: PresetsConfig = {};
  for (const path of paths) {
    const raw = readFile(path);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push({ path, error: 'root must be an object mapping preset name → preset config' });
      continue;
    }
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
        warnings.push({ path, error: `preset name "${name}" must match [a-zA-Z][a-zA-Z0-9_-]*` });
        continue;
      }
      const preset = normalizePreset(path, name, entry, warnings);
      if (preset) merged[name] = preset;
    }
  }
  const nameOrder = Object.keys(merged).sort();
  return { presets: merged, nameOrder, warnings };
}

/**
 * Default file-backed reader: returns `undefined` for missing files
 * so the loader can skip them silently. Rethrows nothing; any error
 * becomes `undefined` and gets picked up as "absent" downstream.
 */
export function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Compact one-line summary of what a preset does. Used by `/preset`
 * listing and the status widget.
 */
export function describePreset(preset: Preset): string {
  const parts: string[] = [];
  if (preset.model) parts.push(preset.model);
  if (preset.thinkingLevel) parts.push(`thinking=${preset.thinkingLevel}`);
  if (preset.tools) parts.push(`tools=${preset.tools.join(',')}`);
  if (preset.appendSystemPrompt) {
    const body = preset.appendSystemPrompt.replace(/\s+/g, ' ').trim();
    parts.push(`prompt="${body.length > 40 ? `${body.slice(0, 37)}...` : body}"`);
  }
  return parts.join(' | ');
}

export { THINKING_LEVELS };
