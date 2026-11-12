/**
 * Tests for lib/node/pi/memory/actions.ts (the shared `memory` tool
 * actions), on an explicit temp root so `PI_MEMORY_ROOT` is never consulted.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { clearScanCache, fileFor, indexFileFor, rebuildMemoryIndex } from '../../../../../lib/node/pi/memory-paths.ts';
import { type MemoryState } from '../../../../../lib/node/pi/memory-reducer.ts';
import {
  type MemoryActionIo,
  type MemoryActionParams,
  type MemoryActionResult,
  runMemoryAction,
} from '../../../../../lib/node/pi/memory/actions.ts';

const CWD = '/work/demo';
const SID = 'ses_test';
let root: string;
let io: MemoryActionIo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-actions-'));
  io = { cwd: CWD, sessionId: SID, root, now: () => new Date('2026-11-12T10:00:00.000Z') };
  clearScanCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const scan = (): MemoryState => rebuildMemoryIndex(CWD, SID, root).state;
const run = (params: MemoryActionParams, over: Partial<MemoryActionIo> = {}): MemoryActionResult =>
  runMemoryAction(scan(), params, { ...io, ...over });

test('runMemoryAction: save writes the file and MEMORY.md under the given root', () => {
  const r = run({
    action: 'save',
    type: 'feedback',
    name: 'Terse replies',
    description: 'keep it short',
    body: 'Be terse.',
  });
  expect(r.isError).toBeUndefined();
  expect(r.content).toBe('Saved memory [global/feedback] `terse-replies` - keep it short');
  expect(r.change).toMatchObject({ kind: 'upsert', entry: { id: 'terse-replies' } });
  const file = fileFor('global', 'feedback', 'terse-replies', CWD, SID, root);
  expect(readFileSync(file, 'utf8')).toBe(
    [
      '---',
      'name: Terse replies',
      'description: keep it short',
      'type: feedback',
      'created: "2026-11-12T10:00:00.000Z"',
      'updated: "2026-11-12T10:00:00.000Z"',
      '---',
      '',
      'Be terse.',
      '',
    ].join('\n'),
  );
  expect(readFileSync(indexFileFor('global', CWD, SID, root), 'utf8')).toContain(
    '- [Terse replies](feedback/terse-replies.md) - keep it short',
  );
  expect(scan().index.global.map((e) => e.id)).toEqual(['terse-replies']);
});

test('runMemoryAction: a second save of the same name gets a distinct slug and a duplicate note', () => {
  run({ action: 'save', type: 'user', name: 'Role', description: 'data scientist', body: 'DS on logging.' });
  const r = run({ action: 'save', type: 'user', name: 'Role', description: 'data scientist', body: 'DS on logging.' });
  expect(r.content).toMatch(/^Note: this looks similar to existing memory `role`/);
  expect(r.entry?.id).toBe('role-2');
});

test('runMemoryAction: update renames, preserves created, and drops the old file', () => {
  run({ action: 'save', type: 'project', name: 'Freeze', description: 'merge freeze', body: 'Freeze on 2026-11-20.' });
  const later = { now: () => new Date('2026-11-13T00:00:00.000Z') };
  const r = run({ action: 'update', id: 'freeze', name: 'Merge freeze' }, later);
  expect(r.content).toBe('Updated memory [project/project] `merge-freeze` - merge freeze');
  expect(existsSync(fileFor('project', 'project', 'freeze', CWD, SID, root))).toBe(false);
  const raw = readFileSync(fileFor('project', 'project', 'merge-freeze', CWD, SID, root), 'utf8');
  expect(raw).toContain('created: "2026-11-12T10:00:00.000Z"');
  expect(raw).toContain('updated: "2026-11-13T00:00:00.000Z"');
  expect(raw).toContain('Freeze on 2026-11-20.');
  expect(r.change).toMatchObject({ kind: 'upsert', replaced: { id: 'freeze' } });
});

test('runMemoryAction: remove requires scope and deletes the entry', () => {
  run({ action: 'save', scope: 'session', name: 'Flaky test', description: 'retry it', body: 'Use --runInBand.' });
  expect(run({ action: 'remove', id: 'flaky-test' })).toMatchObject({ isError: true });
  const r = run({ action: 'remove', id: 'flaky-test', scope: 'session' });
  expect(r.content).toBe('Removed memory [session/note] `flaky-test`');
  expect(scan().index.session).toEqual([]);
});

test('runMemoryAction: read, search, and list report the stored memory', () => {
  run({ action: 'save', type: 'reference', name: 'Tracker', description: 'INGEST bugs', body: 'Linear INGEST.' });
  expect(run({ action: 'read', id: 'tracker' }).content).toBe(
    '[project/reference] tracker - Tracker\nINGEST bugs\n\nLinear INGEST.\n',
  );
  expect(run({ action: 'search', query: 'linear' }).matches?.map((e) => e.id)).toEqual(['tracker']);
  expect(run({ action: 'search', query: '' })).toMatchObject({ isError: true });
  expect(run({ action: 'list' }).content).toContain('[reference] tracker - Tracker: INGEST bugs');
});

test('runMemoryAction: read-only blocks writes but not reads', () => {
  const ro = { readOnlyReason: 'OPENCODE_MEMORY_READ_ONLY=1' };
  const r = run({ action: 'save', type: 'user', name: 'x', description: 'y', body: 'z' }, ro);
  expect(r).toMatchObject({ isError: true, content: 'Error: memory is read-only: OPENCODE_MEMORY_READ_ONLY=1' });
  expect(run({ action: 'list' }, ro).isError).toBeUndefined();
});

test('runMemoryAction: session scope without a session id is rejected', () => {
  const r = run({ action: 'save', scope: 'session', name: 'n', description: 'd', body: 'b' }, { sessionId: null });
  expect(r.isError).toBe(true);
  expect(r.error).toMatch(/^session memory is disabled/);
});
