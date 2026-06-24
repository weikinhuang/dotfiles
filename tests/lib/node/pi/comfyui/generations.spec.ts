/**
 * Tests for lib/node/pi/comfyui/generations.ts.
 */

import { describe, expect, test } from 'vitest';

import type { BranchEntry } from '../../../../../lib/node/pi/branch-state.ts';
import {
  addGeneration,
  allocateGenerationId,
  cloneGenerations,
  emptyGenerations,
  findGeneration,
  findGenerationByPrompt,
  formatGallery,
  formatGenerationDetail,
  formatGenerationHint,
  formatGenerationLine,
  type GenerationRegistry,
  isGenerationRegistryShape,
  reduceGenerations,
} from '../../../../../lib/node/pi/comfyui/generations.ts';

function seedReg(): GenerationRegistry {
  const a = addGeneration(emptyGenerations(), {
    workflow: 'anima',
    promptId: 'p1',
    prompt: 'a cat',
    seed: 123,
    width: 1024,
    height: 1024,
    savedPaths: ['/out/a.png'],
    source: 'foreground',
    createdAt: 1,
  });
  const b = addGeneration(a.registry, {
    workflow: 'flux2-t2i',
    promptId: 'p2',
    prompt: 'a dog',
    savedPaths: ['/out/b.png', '/out/c.png'],
    source: 'background',
    createdAt: 2,
  });
  return b.registry;
}

describe('addGeneration / allocateGenerationId', () => {
  test('assigns g-prefixed monotonic ids and bumps nextId', () => {
    expect(allocateGenerationId(emptyGenerations())).toBe('g1');
    const reg = seedReg();
    expect(reg.generations.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(reg.nextId).toBe(3);
    expect(allocateGenerationId(reg)).toBe('g3');
  });

  test('does not mutate the input registry', () => {
    const empty = emptyGenerations();
    addGeneration(empty, { workflow: 'w', prompt: 'p', savedPaths: [], source: 'foreground', createdAt: 1 });
    expect(empty.generations).toEqual([]);
    expect(empty.nextId).toBe(1);
  });
});

describe('lookups', () => {
  test('findGeneration by id and findGenerationByPrompt by promptId', () => {
    const reg = seedReg();
    expect(findGeneration(reg, 'g2')?.workflow).toBe('flux2-t2i');
    expect(findGeneration(reg, 'nope')).toBeUndefined();
    expect(findGenerationByPrompt(reg, 'p1')?.id).toBe('g1');
    expect(findGenerationByPrompt(reg, 'absent')).toBeUndefined();
  });
});

describe('formatting', () => {
  test('formatGenerationLine includes seed, dims, count, prompt, source', () => {
    const reg = seedReg();
    expect(formatGenerationLine(reg.generations[0])).toBe(
      '[g1] anima · seed 123 · 1024x1024 · 1 image · "a cat" · (foreground)',
    );
    expect(formatGenerationLine(reg.generations[1])).toBe('[g2] flux2-t2i · 2 images · "a dog" · (background)');
  });

  test('formatGallery joins lines or notes empty', () => {
    expect(formatGallery(emptyGenerations())).toBe('(no generations yet)');
    expect(formatGallery(seedReg())).toContain('[g1]');
    expect(formatGallery(seedReg())).toContain('[g2]');
  });

  test('formatGenerationDetail shows the untruncated prompt, metadata, and files', () => {
    const rec = addGeneration(emptyGenerations(), {
      workflow: 'anima',
      prompt: '1girl, solo, '.repeat(20).trim(),
      negative: 'lowres, bad anatomy',
      seed: 7,
      width: 832,
      height: 1216,
      savedPaths: ['/out/x.png'],
      source: 'background',
      createdAt: 1,
    }).created;
    const out = formatGenerationDetail(rec);
    expect(out).toContain('[g1] anima (background)');
    expect(out).toContain('seed 7 · 832x1216');
    expect(out).toContain(`prompt:   ${rec.prompt}`); // full, untruncated
    expect(out).toContain('negative: lowres, bad anatomy');
    expect(out).toContain('file:     /out/x.png');
  });

  test('formatGenerationDetail omits an absent negative and missing dims', () => {
    const out = formatGenerationDetail(seedReg().generations[1]); // g2: no seed, no dims, no negative
    expect(out).toContain('[g2] flux2-t2i (background)');
    expect(out).not.toContain('negative:');
    expect(out).not.toContain('seed');
    expect(out).toContain('file:     /out/b.png');
    expect(out).toContain('file:     /out/c.png');
  });

  test('formatGenerationDetail prints the auto-refine journey + lineage when present', () => {
    const rec = addGeneration(emptyGenerations(), {
      workflow: 'anima',
      prompt: 'a cat',
      seed: 9,
      savedPaths: ['/out/r2.png'],
      source: 'foreground',
      createdAt: 1,
      refineOf: 'g1',
      refine: {
        rounds: 2,
        accepted: true,
        finalScore: 8,
        journey: [
          { action: 'initial', score: 4, savedPath: '/out/r0.png' },
          { action: 'reroll', score: 6, savedPath: '/out/r1.png' },
          { action: 'revise_prompt', score: 8, savedPath: '/out/r2.png' },
        ],
      },
    }).created;
    const out = formatGenerationDetail(rec);
    expect(out).toContain('refined from: g1');
    expect(out).toContain('auto-refine: 2 rounds · accepted · score 8');
    expect(out).toContain('- initial (score 4) -> /out/r0.png');
    expect(out).toContain('- revise_prompt (score 8) -> /out/r2.png');
  });

  test('addGeneration threads the refine journey + refineOf onto the record', () => {
    const created = addGeneration(emptyGenerations(), {
      workflow: 'anima',
      prompt: 'a cat',
      savedPaths: ['/out/r1.png'],
      source: 'foreground',
      createdAt: 1,
      refineOf: 'g3',
      refine: { rounds: 1, accepted: false, finalScore: 6, journey: [{ action: 'initial', score: 6 }] },
    }).created;
    expect(created.refineOf).toBe('g3');
    expect(created.refine?.accepted).toBe(false);
  });

  test('formatGenerationHint shows workflow + clipped prompt snippet', () => {
    const reg = seedReg();
    expect(formatGenerationHint(reg.generations[0])).toBe('anima · a cat');
    const long = addGeneration(emptyGenerations(), {
      workflow: 'anima',
      prompt: 'x'.repeat(80),
      savedPaths: [],
      source: 'background',
      createdAt: 1,
    }).created;
    const hint = formatGenerationHint(long);
    expect(hint.startsWith('anima · ')).toBe(true);
    expect(hint.endsWith('…')).toBe(true);
    expect(hint.length).toBeLessThanOrEqual('anima · '.length + 50);
  });
});

describe('persistence shape + reduce', () => {
  test('isGenerationRegistryShape accepts a real registry and rejects junk', () => {
    expect(isGenerationRegistryShape(seedReg())).toBe(true);
    expect(isGenerationRegistryShape(null)).toBe(false);
    expect(isGenerationRegistryShape({ generations: [], nextId: 'x' })).toBe(false);
    expect(isGenerationRegistryShape({ generations: [{ id: 'g1' }], nextId: 2 })).toBe(false);
    expect(
      isGenerationRegistryShape({
        generations: [{ id: 'g1', workflow: 'w', prompt: 'p', savedPaths: [], source: 'bad', createdAt: 1 }],
        nextId: 2,
      }),
    ).toBe(false);
  });

  test('reduceGenerations returns the latest custom snapshot newest-first', () => {
    const older = seedReg();
    const newer = addGeneration(older, {
      workflow: 'anima',
      prompt: 'a bird',
      savedPaths: ['/out/d.png'],
      source: 'foreground',
      createdAt: 3,
    }).registry;
    const branch: BranchEntry[] = [
      { type: 'custom', customType: 'comfyui-generations', data: older },
      { type: 'custom', customType: 'comfyui-generations', data: newer },
    ];
    const out = reduceGenerations(branch, 'comfyui-generations');
    expect(out.generations.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
    expect(out.nextId).toBe(4);
  });

  test('reduceGenerations falls back to empty when no snapshot present', () => {
    expect(reduceGenerations([], 'comfyui-generations')).toEqual(emptyGenerations());
    const branch: BranchEntry[] = [{ type: 'custom', customType: 'other', data: { x: 1 } }];
    expect(reduceGenerations(branch, 'comfyui-generations')).toEqual(emptyGenerations());
  });

  test('cloneGenerations deep-copies savedPaths', () => {
    const reg = seedReg();
    const copy = cloneGenerations(reg);
    copy.generations[0].savedPaths.push('/out/extra.png');
    expect(reg.generations[0].savedPaths).toEqual(['/out/a.png']);
  });
});
