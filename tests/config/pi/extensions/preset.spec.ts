/**
 * Tests for the `preset` extension's command surface.
 *
 * Sits under `tests/config/pi/extensions/` to document the `/preset`
 * command shell, but - per project convention - only drives the pure lib
 * helpers the shell composes (`completeSubverbs`, `isHelpArg`,
 * `describePreset`, `PRESET_USAGE`). The shell itself pulls in
 * `@earendil-works/*` and can't be imported under vitest, so we mirror the
 * exact `completeSubverbs` spec the shell builds.
 */

import { expect, test, vi } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { describePreset, type PresetsConfig } from '../../../../lib/node/pi/preset.ts';
import { PRESET_USAGE } from '../../../../lib/node/pi/preset/usage.ts';

const PRESETS: PresetsConfig = {
  'qwen3-local': { model: 'llama-cpp/qwen3', thinkingLevel: 'high' },
  'opus-heavy': { model: 'anthropic/claude-opus', thinkingLevel: 'high' },
};
const NAME_ORDER = ['qwen3-local', 'opus-heavy'];

// ──────────────────────────────────────────────────────────────────────
// Help convention - the handler guards with `isHelpArg`, notifying
// PRESET_USAGE at info level.
// ──────────────────────────────────────────────────────────────────────

test('help: `/preset --help` notifies PRESET_USAGE', () => {
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  if (isHelpArg('--help')) notify(PRESET_USAGE, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  const [msg, level] = notify.mock.calls[0];
  expect(level).toBe('info');
  expect(msg).toBe(PRESET_USAGE);
  expect(PRESET_USAGE).toContain('/preset');
});

// ──────────────────────────────────────────────────────────────────────
// Argument completion (§4.1). The shell builds a `completeSubverbs` spec
// of every preset name (with its `describePreset` summary) plus the `off`
// verb. All are terminal (no level-2 args). We mirror that exact spec.
// ──────────────────────────────────────────────────────────────────────

/** Mirror of `config/pi/extensions/preset.ts`'s getArgumentCompletions spec. */
function buildPresetSpec(): SubverbSpec {
  const spec: SubverbSpec = {};
  for (const n of NAME_ORDER) spec[n] = { description: describePreset(PRESETS[n]) };
  spec.off = { description: 'Clear preset, restore prior state' };
  return spec;
}

const presetCompletions = (prefix: string): { value: string; label: string; description?: string }[] | null =>
  completeSubverbs(prefix, buildPresetSpec());

test('completion: level-1 lists every preset name then the off verb', () => {
  const out = presetCompletions('');
  expect(out?.map((c) => c.value)).toEqual([...NAME_ORDER, 'off']);
});

test('completion: each name row carries its describePreset summary', () => {
  const out = presetCompletions('');
  const qwen = out?.find((c) => c.value === 'qwen3-local');
  expect(qwen?.description).toBe(describePreset(PRESETS['qwen3-local']));
  const off = out?.find((c) => c.value === 'off');
  expect(off?.description).toBe('Clear preset, restore prior state');
});

test('completion: filters by the typed prefix', () => {
  expect(presetCompletions('of')?.map((c) => c.value)).toEqual(['off']);
  expect(presetCompletions('qwen')?.map((c) => c.value)).toEqual(['qwen3-local']);
});

test('completion: returns null when nothing matches', () => {
  expect(presetCompletions('zzz')).toBeNull();
});

test('completion: a terminal verb takes no level-2 args', () => {
  // `/preset off <Tab>` -> off is terminal, so no deeper candidates.
  expect(presetCompletions('off ')).toBeNull();
  expect(presetCompletions('qwen3-local ')).toBeNull();
});
