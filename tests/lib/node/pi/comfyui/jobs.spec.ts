/**
 * Tests for lib/node/pi/comfyui/jobs.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  addJob,
  allocateId,
  emptyRegistry,
  findJob,
  formatDuration,
  formatJobLine,
  formatRegistry,
  formatRunningBlock,
  type NewJob,
  removeJob,
  runningJobs,
  statusGlyph,
  updateJob,
} from '../../../../../lib/node/pi/comfyui/jobs.ts';

function sampleJob(over: Partial<NewJob> = {}): NewJob {
  return {
    promptId: 'p-abc',
    workflow: 'anima',
    seed: 123,
    prompt: 'a cat',
    negative: 'blurry',
    saveDir: '/out',
    sendToModel: true,
    startedAt: 1000,
    ...over,
  };
}

describe('addJob / allocateId', () => {
  test('appends a running job and bumps nextId', () => {
    const r0 = emptyRegistry();
    expect(allocateId(r0)).toBe('1');
    const { registry: r1, created } = addJob(r0, sampleJob());
    expect(created.id).toBe('1');
    expect(created.status).toBe('running');
    expect(created.savedPaths).toEqual([]);
    expect(r1.nextId).toBe(2);
    expect(r1.jobs).toHaveLength(1);
    // Source registry is untouched (immutability).
    expect(r0.jobs).toHaveLength(0);
  });

  test('ids are monotonic across adds', () => {
    let reg = emptyRegistry();
    reg = addJob(reg, sampleJob()).registry;
    const { created } = addJob(reg, sampleJob({ promptId: 'p-2' }));
    expect(created.id).toBe('2');
  });
});

describe('findJob / updateJob / removeJob', () => {
  test('findJob returns the matching job or undefined', () => {
    const { registry } = addJob(emptyRegistry(), sampleJob());
    expect(findJob(registry, '1')?.promptId).toBe('p-abc');
    expect(findJob(registry, '9')).toBeUndefined();
  });

  test('updateJob immutably patches the named job and leaves others alone', () => {
    let reg = addJob(emptyRegistry(), sampleJob()).registry;
    reg = addJob(reg, sampleJob({ promptId: 'p-2' })).registry;
    const next = updateJob(reg, '1', { status: 'done', savedPaths: ['/out/a.png'], endedAt: 2000 });
    expect(findJob(next, '1')?.status).toBe('done');
    expect(findJob(next, '1')?.savedPaths).toEqual(['/out/a.png']);
    expect(findJob(next, '2')?.status).toBe('running');
    // Original unchanged.
    expect(findJob(reg, '1')?.status).toBe('running');
  });

  test('updateJob is a no-op for an unknown id', () => {
    const reg = addJob(emptyRegistry(), sampleJob()).registry;
    expect(updateJob(reg, '9', { status: 'done' })).toBe(reg);
  });

  test('removeJob drops the job and reports whether anything changed', () => {
    const reg = addJob(emptyRegistry(), sampleJob()).registry;
    const hit = removeJob(reg, '1');
    expect(hit.removed).toBe(true);
    expect(hit.registry.jobs).toHaveLength(0);
    const miss = removeJob(reg, '9');
    expect(miss.removed).toBe(false);
  });
});

describe('runningJobs', () => {
  test('returns only jobs still in the running state', () => {
    let reg = addJob(emptyRegistry(), sampleJob()).registry;
    reg = addJob(reg, sampleJob({ promptId: 'p-2' })).registry;
    reg = updateJob(reg, '1', { status: 'done' });
    expect(runningJobs(reg).map((j) => j.id)).toEqual(['2']);
  });
});

describe('formatDuration', () => {
  test('sub-minute renders as seconds', () => {
    expect(formatDuration(0, 14_000)).toBe('14s');
    expect(formatDuration(0, 0)).toBe('0s');
  });

  test('over a minute renders mm and zero-padded ss', () => {
    expect(formatDuration(0, 63_000)).toBe('1m03s');
    expect(formatDuration(0, 600_000)).toBe('10m00s');
  });

  test('never goes negative', () => {
    expect(formatDuration(5000, 0)).toBe('0s');
  });
});

describe('formatJobLine', () => {
  test('done job shows image count and elapsed', () => {
    const reg = updateJob(addJob(emptyRegistry(), sampleJob()).registry, '1', {
      status: 'done',
      savedPaths: ['/out/a.png', '/out/b.png'],
      endedAt: 15_000,
    });
    expect(formatJobLine(findJob(reg, '1')!, 99_999)).toBe('[1] ✓ done · anima · seed 123 · 2 images · 14s');
  });

  test('error job shows the reason', () => {
    const reg = updateJob(addJob(emptyRegistry(), sampleJob()).registry, '1', {
      status: 'error',
      error: 'execution failed',
      endedAt: 1000,
    });
    expect(formatJobLine(findJob(reg, '1')!, 1000)).toBe('[1] ✗ error · anima · seed 123 · execution failed · 0s');
  });

  test('running job uses now for elapsed', () => {
    const reg = addJob(emptyRegistry(), sampleJob()).registry;
    expect(formatJobLine(findJob(reg, '1')!, 6000)).toBe('[1] ⟳ running · anima · seed 123 · 5s');
  });
});

describe('formatRegistry / formatRunningBlock', () => {
  test('empty registry has an empty-state note and no running block', () => {
    expect(formatRegistry(emptyRegistry(), 0)).toBe('(no background image jobs)');
    expect(formatRunningBlock(emptyRegistry())).toBeUndefined();
  });

  test('running block lists only running jobs with a collect hint', () => {
    let reg = addJob(emptyRegistry(), sampleJob()).registry;
    reg = addJob(reg, sampleJob({ promptId: 'p-2', seed: undefined, workflow: 'txt2img' })).registry;
    reg = updateJob(reg, '1', { status: 'done' });
    const block = formatRunningBlock(reg);
    expect(block).toContain('## Pending image jobs');
    expect(block).toContain('[2] txt2img');
    expect(block).not.toContain('[1]');
  });
});

describe('statusGlyph', () => {
  test('maps each status to its glyph', () => {
    expect(statusGlyph('running')).toBe('⟳');
    expect(statusGlyph('done')).toBe('✓');
    expect(statusGlyph('error')).toBe('✗');
    expect(statusGlyph('cancelled')).toBe('◌');
  });
});
