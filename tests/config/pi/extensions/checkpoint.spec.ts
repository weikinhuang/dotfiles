/**
 * Tests for the `checkpoint` extension's command surface.
 *
 * The extension shell (`config/pi/extensions/checkpoint.ts`) is thin glue;
 * all logic lives in the pure helpers under `lib/node/pi/checkpoint/` (each
 * covered by its own spec). This spec pins the `/rewind` command surface -
 * the `--help` guard and the argument completion at every token position -
 * by exercising the exact pure helpers the shell wires in, so the two stay
 * in lockstep without needing the pi runtime.
 */

import { describe, expect, test } from 'vitest';

import { rewindCompletions } from '../../../../lib/node/pi/checkpoint/complete.ts';
import { REWIND_USAGE } from '../../../../lib/node/pi/checkpoint/usage.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';

const ANCHORS = ['8749c0b8', 'bc03165f'];

describe('/rewind --help', () => {
  test('isHelpArg matches the help tokens the handler guards on', () => {
    for (const arg of ['help', '--help', '-h', '?']) expect(isHelpArg(arg)).toBe(true);
    expect(isHelpArg('list')).toBe(false);
    expect(isHelpArg('')).toBe(false);
  });

  test('USAGE documents the three argument forms', () => {
    expect(REWIND_USAGE).toContain('/rewind list');
    expect(REWIND_USAGE).toContain('/rewind <entryId>');
    expect(REWIND_USAGE).toMatch(/recompute the plan/);
  });
});

describe('/rewind completions', () => {
  test('empty prefix offers list + every anchor id', () => {
    const items = rewindCompletions('', ANCHORS);
    expect(items?.map((i) => i.value)).toEqual(['list', ...ANCHORS]);
  });

  test('prefix filters to the matching verb', () => {
    const items = rewindCompletions('li', ANCHORS);
    expect(items?.map((i) => i.value)).toEqual(['list']);
  });

  test('prefix filters to the matching anchor id and carries the full value', () => {
    const items = rewindCompletions('bc', ANCHORS);
    expect(items).toEqual([
      { value: 'bc03165f', label: 'bc03165f', description: 'Restore files to this checkpoint anchor' },
    ]);
  });

  test('returns null when nothing matches', () => {
    expect(rewindCompletions('zzz', ANCHORS)).toBeNull();
  });

  test('with no recorded checkpoints, only list is offered', () => {
    expect(rewindCompletions('', [])?.map((i) => i.value)).toEqual(['list']);
  });
});
