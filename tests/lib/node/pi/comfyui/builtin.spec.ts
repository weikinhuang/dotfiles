/**
 * Tests for lib/node/pi/comfyui/builtin.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  type BuiltinManifest,
  parseBuiltinSelection,
  pickBuiltinDefault,
  resolveManifestPath,
  resolveManifestWorkflows,
  selectBuiltinWorkflows,
} from '../../../../../lib/node/pi/comfyui/builtin.ts';

const manifest: BuiltinManifest = {
  defaultWorkflow: 'gen',
  defaultSet: ['gen', 'edit', 'missing'],
  workflows: {
    gen: { file: 'gen.json', inputs: {}, refineWith: { inpaint: 'fix', detailer: 'detail' } },
    edit: { file: 'edit.json', inputs: {} },
    fix: { file: 'fix.json', inputs: {} },
    detail: { file: 'detail.json', inputs: {} },
  },
};

describe('parseBuiltinSelection', () => {
  test('splits and trims a comma string, dropping empties', () => {
    expect(parseBuiltinSelection(' default ,, krea2 ')).toEqual(['default', 'krea2']);
  });

  test('a blank string means unset, an empty array means an explicit empty selection', () => {
    expect(parseBuiltinSelection('  ')).toBeUndefined();
    expect(parseBuiltinSelection([])).toEqual([]);
  });

  test('keeps string array entries and rejects other shapes', () => {
    expect(parseBuiltinSelection(['a', 1, ' b '])).toEqual(['a', 'b']);
    expect(parseBuiltinSelection(undefined)).toBeUndefined();
    expect(parseBuiltinSelection({ a: 1 })).toBeUndefined();
  });
});

describe('resolveManifestPath / resolveManifestWorkflows', () => {
  test('joins relative paths and keeps ~ and absolute ones', () => {
    expect(resolveManifestPath('a.json', '/m')).toBe('/m/a.json');
    expect(resolveManifestPath('~/a.json', '/m')).toBe('~/a.json');
    expect(resolveManifestPath('/x/a.json', '/m')).toBe('/x/a.json');
  });

  test('resolves file, guidanceFile, and refineGuidanceFile', () => {
    const out = resolveManifestWorkflows(
      { w: { file: 'w.json', guidanceFile: 'g.md', refineGuidanceFile: 'r.md', inputs: {} } },
      '/m',
    );
    expect(out.w).toMatchObject({ file: '/m/w.json', guidanceFile: '/m/g.md', refineGuidanceFile: '/m/r.md' });
  });
});

describe('selectBuiltinWorkflows', () => {
  test('default expands the default set, skipping names the manifest lacks', () => {
    const { workflows, unknown } = selectBuiltinWorkflows(manifest, ['default']);
    expect(Object.keys(workflows)).toEqual(['gen', 'edit']);
    expect(unknown).toEqual([]);
  });

  test('all selects every workflow in manifest order', () => {
    expect(Object.keys(selectBuiltinWorkflows(manifest, ['all']).workflows)).toEqual(['gen', 'edit', 'fix', 'detail']);
  });

  test('none and an empty selection pick nothing', () => {
    expect(selectBuiltinWorkflows(manifest, ['none']).workflows).toEqual({});
    expect(selectBuiltinWorkflows(manifest, []).workflows).toEqual({});
  });

  test('reports unknown tokens and follows manifest order, not token order', () => {
    const { workflows, unknown } = selectBuiltinWorkflows(manifest, ['edit', 'nope', 'gen']);
    expect(Object.keys(workflows)).toEqual(['gen', 'edit']);
    expect(unknown).toEqual(['nope']);
  });

  test('prunes refineWith companions that are not selected', () => {
    expect(selectBuiltinWorkflows(manifest, ['gen']).workflows.gen.refineWith).toBeUndefined();
    expect(selectBuiltinWorkflows(manifest, ['gen', 'fix']).workflows.gen.refineWith).toEqual({ inpaint: 'fix' });
    expect(selectBuiltinWorkflows(manifest, ['all']).workflows.gen.refineWith).toEqual({
      inpaint: 'fix',
      detailer: 'detail',
    });
  });
});

describe('pickBuiltinDefault', () => {
  test('prefers the manifest default, else the first selected', () => {
    expect(pickBuiltinDefault(manifest, selectBuiltinWorkflows(manifest, ['all']).workflows)).toBe('gen');
    expect(pickBuiltinDefault(manifest, selectBuiltinWorkflows(manifest, ['fix', 'edit']).workflows)).toBe('edit');
    expect(pickBuiltinDefault(manifest, {})).toBeUndefined();
  });
});
