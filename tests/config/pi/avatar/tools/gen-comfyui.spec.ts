/**
 * Tests for config/pi/avatar/tools/gen-comfyui.ts pure helpers.
 *
 * Pure module - no network or pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  collectCells,
  hashState,
  parseArgs,
  sourceImagePath,
  stateSeed,
} from '../../../../../config/pi/avatar/tools/gen-comfyui.ts';

describe('parseArgs', () => {
  test('defaults server from PI_COMFYUI_URL', () => {
    const opts = parseArgs([], { PI_COMFYUI_URL: 'http://comfy.local:8188/' });
    expect(opts.server).toBe('http://comfy.local:8188');
    expect(opts.out).toBe('avatar-ref/gen');
    expect(opts.identityFile).toBe('avatar-ref/identity.txt');
  });

  test('collects repeatable workflow flags and numeric overrides', () => {
    const opts = parseArgs([
      '--workflow',
      'anima',
      '--workflow',
      'kontext',
      '--group',
      'Activities',
      '--states',
      'hi,idle',
      '--limit',
      '3',
      '--seed',
      '42',
      '--steps',
      '20',
      '--cfg',
      '4.5',
      '--denoise',
      '0.6',
      '--canonical',
      'avatar-ref/canonical.png',
      '--negative',
      'blurry',
      '--dry-run',
    ]);
    expect(opts.workflows).toEqual(['anima', 'kontext']);
    expect(opts.group).toBe('activities');
    expect(opts.states).toEqual(['hi', 'idle']);
    expect(opts.limit).toBe(3);
    expect(opts.seed).toBe(42);
    expect(opts.steps).toBe(20);
    expect(opts.cfg).toBe(4.5);
    expect(opts.denoise).toBe(0.6);
    expect(opts.canonical).toBe('avatar-ref/canonical.png');
    expect(opts.negative).toBe('blurry');
    expect(opts.dryRun).toBe(true);
  });

  test('supports --flag=value form', () => {
    const opts = parseArgs(['--server=http://127.0.0.1:9999', '--ping']);
    expect(opts.server).toBe('http://127.0.0.1:9999');
    expect(opts.ping).toBe(true);
  });

  test('--hero is off by default and toggles on', () => {
    expect(parseArgs([]).hero).toBe(false);
    expect(parseArgs(['--hero']).hero).toBe(true);
  });

  test('throws on unknown arguments', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });
});

describe('stateSeed', () => {
  test('hashState is stable for the same state name', () => {
    expect(hashState('idle')).toBe(hashState('idle'));
    expect(hashState('idle')).not.toBe(hashState('hi'));
  });

  test('stateSeed combines base seed with the state hash', () => {
    const base = 1_000;
    expect(stateSeed('idle', base)).toBe((base + hashState('idle')) % 1e15);
    expect(stateSeed('idle', base)).toBe(stateSeed('idle', base));
    expect(stateSeed('hi', base)).not.toBe(stateSeed('idle', base));
  });
});

describe('sourceImagePath', () => {
  test('generate role never needs a source image', () => {
    expect(
      sourceImagePath('generate', 'idle', 1, 'avatar-ref/canonical.png', 'avatar-ref/gen', 'anima'),
    ).toBeUndefined();
  });

  test('edit role uses canonical for frame 0', () => {
    expect(sourceImagePath('edit', 'idle', 0, 'avatar-ref/canonical.png', 'avatar-ref/gen', 'kontext')).toBe(
      'avatar-ref/canonical.png',
    );
  });

  test('edit role uses that state frame 0 for later frames', () => {
    expect(sourceImagePath('edit', 'idle', 1, 'avatar-ref/canonical.png', 'avatar-ref/gen', 'kontext')).toBe(
      'avatar-ref/gen/kontext/idle.0.png',
    );
    expect(sourceImagePath('edit', 'idle', 2, 'avatar-ref/canonical.png', 'avatar-ref/gen', 'kontext')).toBe(
      'avatar-ref/gen/kontext/idle.0.png',
    );
  });
});

describe('collectCells', () => {
  test('expands one group into state-then-frame order', () => {
    const cells = collectCells('workflow', [], undefined);
    expect(cells.slice(0, 3)).toEqual([
      { group: 'workflow', state: 'debug', frame: 0 },
      { group: 'workflow', state: 'debug', frame: 1 },
      { group: 'workflow', state: 'debug', frame: 2 },
    ]);
  });

  test('filters to explicit states and applies limit', () => {
    const cells = collectCells('activities', ['hi', 'idle'], 3);
    expect(cells).toEqual([
      { group: 'activities', state: 'hi', frame: 0 },
      { group: 'activities', state: 'hi', frame: 1 },
      { group: 'activities', state: 'hi', frame: 2 },
    ]);
  });

  test('rejects a state outside the requested group', () => {
    expect(() => collectCells('workflow', ['idle'], undefined)).toThrow('State "idle" is not in group "workflow"');
  });
});
