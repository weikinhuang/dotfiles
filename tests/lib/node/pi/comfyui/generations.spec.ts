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
