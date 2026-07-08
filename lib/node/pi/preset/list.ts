/**
 * Listing formatter for `/preset` (no args). Pure module - no pi imports
 * - so the format is unit-tested directly under vitest. The extension
 * shell calls this and pipes the result into `ctx.ui.notify`.
 */

import { describePreset, type PresetsConfig } from '../preset.ts';

export interface FormatPresetListingOptions {
  /** Preset names in the order they should appear (load-priority order). */
  nameOrder: readonly string[];
  /** Indexed preset records; each is passed to `describePreset`. */
  presets: Readonly<PresetsConfig>;
  /** Currently-active preset name (`undefined` when none). */
  activeName: string | undefined;
}

/**
 * Render the multi-line listing produced by `/preset` (no args). Returns
 * an empty array when `nameOrder` is empty so the caller can branch on
 * "no presets loaded" without inspecting the formatted lines.
 *
 * Format:
 *
 *   (active: qwen3-local)      ← or `(no preset active)`
 *   * qwen3-local - llama-cpp/qwen3 | thinking=high | tools=bash,read
 *     opus-heavy - anthropic/claude-opus | thinking=high
 *     …
 *
 * The active preset is prefixed with `* ` (two chars including the
 * trailing space); inactive entries are indented to match.
 */
export function formatPresetListing(opts: FormatPresetListingOptions): string[] {
  const { nameOrder, presets, activeName } = opts;

  if (nameOrder.length === 0) {
    return [];
  }

  const activeLine = activeName ? `(active: ${activeName})` : '(no preset active)';
  const lines = nameOrder.map((name) => {
    const prefix = name === activeName ? '* ' : '  ';
    const preset = presets[name];
    return `${prefix}${name} - ${preset ? describePreset(preset) : ''}`;
  });

  return [activeLine, ...lines];
}
