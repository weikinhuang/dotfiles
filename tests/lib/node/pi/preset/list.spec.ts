/**
 * Tests for lib/node/pi/preset/list.ts.
 *
 * Pure module - no pi runtime. Pins the exact multi-line format the
 * `/preset` (no args) listing produces, including the active-marker
 * prefix and the `describePreset` summary per row.
 */

import { describe, expect, test } from 'vitest';

import { formatPresetListing } from '../../../../../lib/node/pi/preset/list.ts';
import type { PresetsConfig } from '../../../../../lib/node/pi/preset.ts';

const PRESETS: PresetsConfig = {
  'qwen3-local': { model: 'llama-cpp/qwen3', thinkingLevel: 'high' },
  'opus-heavy': { model: 'anthropic/claude-opus', thinkingLevel: 'high' },
};
const NAME_ORDER = ['qwen3-local', 'opus-heavy'];

describe('formatPresetListing', () => {
  test('returns an empty array when no presets are loaded', () => {
    expect(formatPresetListing({ nameOrder: [], presets: {}, activeName: undefined })).toEqual([]);
  });

  test('no active preset -> `(no preset active)` header, no `* ` marker', () => {
    const lines = formatPresetListing({ nameOrder: NAME_ORDER, presets: PRESETS, activeName: undefined });

    expect(lines[0]).toBe('(no preset active)');
    expect(lines).toContain('  qwen3-local - llama-cpp/qwen3 | thinking=high');
    expect(lines).toContain('  opus-heavy - anthropic/claude-opus | thinking=high');
    for (const line of lines.slice(1)) expect(line.startsWith('* ')).toBe(false);
  });

  test('active preset -> `(active: <name>)` header and `* ` marks the active row', () => {
    const lines = formatPresetListing({ nameOrder: NAME_ORDER, presets: PRESETS, activeName: 'opus-heavy' });

    expect(lines[0]).toBe('(active: opus-heavy)');
    expect(lines).toContain('* opus-heavy - anthropic/claude-opus | thinking=high');
    expect(lines).toContain('  qwen3-local - llama-cpp/qwen3 | thinking=high');
  });

  test('rows follow nameOrder', () => {
    const lines = formatPresetListing({ nameOrder: NAME_ORDER, presets: PRESETS, activeName: undefined });
    expect(lines.slice(1).map((l) => l.trim().split(' - ')[0])).toEqual(NAME_ORDER);
  });
});
