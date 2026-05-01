/**
 * Tests for lib/node/pi/iteration-loop-storage.ts.
 *
 * Uses a fresh mkdtemp per test to isolate on-disk state.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type CheckSpec } from '../../../../lib/node/pi/iteration-loop-schema.ts';
import {
  acceptDraft,
  activePath,
  archiveTask,
  checksDir,
  discardDraft,
  draftPath,
  listArchive,
  listTasks,
  readSpec,
  snapshotArtifact,
  snapshotPath,
  writeDraft,
  writeSnapshotVerdict,
} from '../../../../lib/node/pi/iteration-loop-storage.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'iter-loop-storage-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const mkSpec = (overrides: Partial<CheckSpec> = {}): CheckSpec => ({
  task: 'default',
  kind: 'bash',
  artifact: 'out.svg',
  spec: { cmd: 'true' },
  createdAt: '2026-05-01T00:00:00Z',
  ...overrides,
});

describe('writeDraft / readSpec / acceptDraft', () => {
  test('readSpec returns state=none when nothing exists', () => {
    const r = readSpec(cwd, 'default');

    expect(r.state).toBe('none');
    expect(r.spec).toBeNull();
  });

  test('writeDraft persists, readSpec returns draft', () => {
    const r = writeDraft(cwd, mkSpec());

    expect(r.ok).toBe(true);
    expect(existsSync(draftPath(cwd, 'default'))).toBe(true);

    const read = readSpec(cwd, 'default');

    expect(read.state).toBe('draft');
    expect(read.spec?.task).toBe('default');
  });

  test('acceptDraft renames to active + sets acceptedAt', () => {
    writeDraft(cwd, mkSpec());
    const r = acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');

    expect(r.ok).toBe(true);

    // eslint-disable-next-line vitest/no-conditional-in-test, vitest/no-conditional-expect
    if (r.ok) expect(r.spec.acceptedAt).toBe('2026-05-01T00:05:00Z');

    expect(existsSync(activePath(cwd, 'default'))).toBe(true);
    expect(existsSync(draftPath(cwd, 'default'))).toBe(false);

    // readSpec prefers active.
    const read = readSpec(cwd, 'default');

    expect(read.state).toBe('active');
  });

  test('acceptDraft fails when no draft', () => {
    const r = acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');

    expect(r.ok).toBe(false);
  });

  test('acceptDraft fails when already accepted', () => {
    writeDraft(cwd, mkSpec());
    acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');
    // Re-write draft (normally forbidden, force for test)
    writeFileSync(draftPath(cwd, 'default'), JSON.stringify(mkSpec()));
    const r = acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');

    expect(r.ok).toBe(false);
  });

  test('writeDraft refuses when active already exists', () => {
    writeDraft(cwd, mkSpec());
    acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');
    const r = writeDraft(cwd, mkSpec());

    expect(r.ok).toBe(false);
  });

  test('readSpec returns error string on malformed JSON', () => {
    mkdirSync(checksDir(cwd), { recursive: true });
    writeFileSync(draftPath(cwd, 'default'), '{not json');
    const r = readSpec(cwd, 'default');

    expect(r.state).toBe('draft');
    expect(r.spec).toBeNull();
    expect(r.error).toMatch(/not valid JSON/);
  });

  test('readSpec returns error on schema mismatch', () => {
    mkdirSync(checksDir(cwd), { recursive: true });
    writeFileSync(draftPath(cwd, 'default'), JSON.stringify({ task: 'x' }));
    const r = readSpec(cwd, 'default');

    expect(r.spec).toBeNull();
    expect(r.error).toMatch(/CheckSpec shape/);
  });
});

describe('discardDraft', () => {
  test('removes draft file; no-op when missing', () => {
    writeDraft(cwd, mkSpec());
    discardDraft(cwd, 'default');

    expect(existsSync(draftPath(cwd, 'default'))).toBe(false);
    expect(() => discardDraft(cwd, 'default')).not.toThrow();
  });
});

describe('snapshotArtifact', () => {
  test('copies bytes + returns sha256', () => {
    writeFileSync(join(cwd, 'out.svg'), '<svg/>');
    const r = snapshotArtifact(cwd, 'default', 1, 'out.svg');

    expect(r).not.toBeNull();
    expect(r?.path).toBe(snapshotPath(cwd, 'default', 1, 'out.svg'));
    expect(r?.path && readFileSync(r.path, 'utf8')).toBe('<svg/>');
    expect(r?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('null when artifact missing', () => {
    const r = snapshotArtifact(cwd, 'default', 1, 'nope.svg');

    expect(r).toBeNull();
  });

  test('same bytes → same hash across iterations', () => {
    writeFileSync(join(cwd, 'out.svg'), 'x');
    const r1 = snapshotArtifact(cwd, 'default', 1, 'out.svg');
    const r2 = snapshotArtifact(cwd, 'default', 2, 'out.svg');

    expect(r1?.hash).toBe(r2?.hash);
  });
});

describe('writeSnapshotVerdict', () => {
  test('writes verdict JSON alongside iteration snapshot', () => {
    const p = writeSnapshotVerdict(cwd, 'default', 1, {
      approved: false,
      score: 0.5,
      issues: [{ severity: 'major', description: 'd' }],
    });
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { approved: boolean; issues: { description: string }[] };

    expect(parsed.approved).toBe(false);
    expect(parsed.issues[0].description).toBe('d');
  });
});

describe('archiveTask', () => {
  test('moves active + snapshots into archive/<ts>-<task>', () => {
    writeDraft(cwd, mkSpec());
    acceptDraft(cwd, 'default', '2026-05-01T00:05:00Z');
    writeFileSync(join(cwd, 'out.svg'), 'x');
    snapshotArtifact(cwd, 'default', 1, 'out.svg');
    const dest = archiveTask(cwd, 'default', '2026-05-01T12-00-00Z');

    expect(dest).not.toBeNull();
    expect(dest && existsSync(join(dest, 'default.json'))).toBe(true);
    expect(dest && existsSync(join(dest, 'default.snapshots'))).toBe(true);
    expect(existsSync(activePath(cwd, 'default'))).toBe(false);
  });

  test('returns null on nothing-to-archive', () => {
    const r = archiveTask(cwd, 'default', '2026-05-01T12-00-00Z');

    expect(r).toBeNull();
  });
});

describe('listTasks / listArchive', () => {
  test('lists drafts + actives with state annotation', () => {
    writeDraft(cwd, mkSpec({ task: 'a' }));
    writeDraft(cwd, mkSpec({ task: 'b' }));
    acceptDraft(cwd, 'b', '2026-05-01T00:05:00Z');
    const tasks = listTasks(cwd);

    expect(tasks).toEqual([
      { task: 'a', state: 'draft', path: draftPath(cwd, 'a') },
      { task: 'b', state: 'active', path: activePath(cwd, 'b') },
    ]);
  });

  test('listArchive newest-first', () => {
    mkdirSync(join(cwd, '.pi/checks/archive/2026-05-01-foo'), { recursive: true });
    mkdirSync(join(cwd, '.pi/checks/archive/2026-05-02-foo'), { recursive: true });
    const arch = listArchive(cwd);

    // Last-hyphen split: "2026-05-01-foo" → timestamp "2026-05-01", task "foo".
    // Newest timestamp first (reverse-lexicographic).
    expect(arch.map((a) => a.timestamp)).toEqual(['2026-05-02', '2026-05-01']);
    expect(arch.map((a) => a.task)).toEqual(['foo', 'foo']);
  });
});
