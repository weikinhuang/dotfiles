/**
 * Layered loader for `modes.json` settings files (shipped → user →
 * project). Each layer can override the active default mode, the
 * disabled list, and per-mode `writeRoots` overrides. Per-mode
 * granularity matters: a project layer that sets `writeRoots.plan`
 * must NOT clobber a user layer that set `writeRoots.journal`.
 *
 * Pure module — no pi imports — so it's directly unit-testable. The
 * caller reads file contents (via fs / pi APIs) and passes them in.
 */

import { parseJsonc } from '../jsonc.ts';
import { type ModeWarning } from './parse.ts';

export interface ModeSettings {
  writeRoots: Record<string, string[]>;
  default?: string;
  disabled?: string[];
}

export interface SettingsLayer {
  source: string;
  raw: string;
}

export interface LoadModeSettingsResult {
  merged: ModeSettings;
  warnings: ModeWarning[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

/**
 * Merge a stack of settings layers, last-wins. `writeRoots` merges per
 * mode-name (so different layers can each contribute different keys);
 * `default` and `disabled` use whole-value last-wins replacement (no
 * accumulation). Bad shapes warn and drop, never throw.
 */
export function loadModeSettings(layers: SettingsLayer[]): LoadModeSettingsResult {
  const warnings: ModeWarning[] = [];
  const merged: ModeSettings = { writeRoots: {} };

  for (const layer of layers) {
    if (layer.raw.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = parseJsonc(layer.raw);
    } catch (e) {
      warnings.push({ path: layer.source, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push({ path: layer.source, reason: 'expected a JSON object at top level' });
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.writeRoots !== undefined) {
      if (obj.writeRoots === null || typeof obj.writeRoots !== 'object' || Array.isArray(obj.writeRoots)) {
        warnings.push({ path: layer.source, reason: '`writeRoots` must be an object' });
      } else {
        const wr = obj.writeRoots as Record<string, unknown>;
        for (const [modeName, value] of Object.entries(wr)) {
          if (!isStringArray(value)) {
            warnings.push({
              path: layer.source,
              reason: `\`writeRoots.${modeName}\` must be an array of strings (dropped)`,
            });
            continue;
          }
          merged.writeRoots[modeName] = [...value];
        }
      }
    }

    if (obj.default !== undefined) {
      if (typeof obj.default !== 'string') {
        warnings.push({ path: layer.source, reason: '`default` must be a string' });
      } else {
        merged.default = obj.default;
      }
    }

    if (obj.disabled !== undefined) {
      if (!isStringArray(obj.disabled)) {
        warnings.push({ path: layer.source, reason: '`disabled` must be an array of strings' });
      } else {
        merged.disabled = [...obj.disabled];
      }
    }
  }

  return { merged, warnings };
}
