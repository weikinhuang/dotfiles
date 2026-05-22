/**
 * Tests for lib/node/pi/apply-patch/apply.ts. Pure module — readFile
 * is dependency-injected and no FS is touched.
 */

import { describe, expect, test } from 'vitest';

import { applyPatch, type ReadFile } from '../../../../../lib/node/pi/apply-patch/apply.ts';
import { type Patch, parsePatch } from '../../../../../lib/node/pi/apply-patch/parse.ts';
import { assertHas } from './helpers.ts';

function parsed(input: string): Patch {
  const out = parsePatch(input);
  if ('error' in out) throw new Error(`parse failed at line ${out.error.line}: ${out.error.message}`);
  return out.patch;
}

function makeFs(entries: Record<string, string>): ReadFile {
  return (path) => (path in entries ? (entries[path] ?? null) : null);
}

// ──────────────────────────────────────────────────────────────────────
// Single-op happy paths
// ──────────────────────────────────────────────────────────────────────

describe('applyPatch: Add File', () => {
  test('writes new file', () => {
    const patch = parsed(
      ['*** Begin Patch', '*** Add File: new/x.ts', '+export const x = 1;', '+', '*** End Patch'].join('\n'),
    );
    const out = applyPatch(patch, makeFs({}));
    assertHas(out, 'plan');
    expect(out.plan.writes.get('new/x.ts')).toBe('export const x = 1;\n');
    expect(out.plan.deletes.size).toBe(0);
    expect(out.plan.moves.size).toBe(0);
  });

  test('Add File over an existing path is rejected', () => {
    const patch = parsed(['*** Begin Patch', '*** Add File: a.ts', '+x', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({ 'a.ts': 'existing\n' }));
    assertHas(out, 'errors');
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.message).toContain('already exists');
  });
});

describe('applyPatch: Delete File', () => {
  test('marks existing file for deletion', () => {
    const patch = parsed(['*** Begin Patch', '*** Delete File: a.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({ 'a.ts': 'bye\n' }));
    assertHas(out, 'plan');
    expect(out.plan.deletes.has('a.ts')).toBe(true);
  });

  test('missing file is rejected', () => {
    const patch = parsed(['*** Begin Patch', '*** Delete File: missing.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({}));
    assertHas(out, 'errors');
    expect(out.errors[0]?.message).toContain('does not exist');
  });
});

describe('applyPatch: Update File', () => {
  test('applies a single hunk', () => {
    const file = ['line a', 'line b', 'line c', ''].join('\n');
    const patch = parsed(
      [
        '*** Begin Patch',
        '*** Update File: f.ts',
        '@@',
        ' line a',
        '-line b',
        '+LINE B',
        ' line c',
        '*** End Patch',
      ].join('\n'),
    );
    const out = applyPatch(patch, makeFs({ 'f.ts': file }));
    assertHas(out, 'plan');
    expect(out.plan.writes.get('f.ts')).toBe(['line a', 'LINE B', 'line c', ''].join('\n'));
  });

  test('applies multiple hunks in file order', () => {
    const file = ['a', 'b', 'c', 'd', 'e', ''].join('\n');
    const patch = parsed(
      [
        '*** Begin Patch',
        '*** Update File: f.ts',
        '@@',
        ' a',
        '-b',
        '+B',
        '@@',
        ' d',
        '-e',
        '+E',
        '*** End Patch',
      ].join('\n'),
    );
    const out = applyPatch(patch, makeFs({ 'f.ts': file }));
    assertHas(out, 'plan');
    expect(out.plan.writes.get('f.ts')).toBe(['a', 'B', 'c', 'd', 'E', ''].join('\n'));
  });

  test('hunk that does not match returns errors with a recovery block', () => {
    const file = 'hello\nworld\n';
    const patch = parsed(
      ['*** Begin Patch', '*** Update File: f.ts', '@@', ' nope', '-still nope', '+x', '*** End Patch'].join('\n'),
    );
    const out = applyPatch(patch, makeFs({ 'f.ts': file }));
    assertHas(out, 'errors');
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.message).toContain('did not match');
    expect(out.errors[0]?.recovery).toBeDefined();
    expect(out.errors[0]?.recovery).toContain('apply-patch op[0]');
  });

  test('missing file is rejected', () => {
    const patch = parsed(
      ['*** Begin Patch', '*** Update File: f.ts', '@@', ' a', '-b', '+B', '*** End Patch'].join('\n'),
    );
    const out = applyPatch(patch, makeFs({}));
    assertHas(out, 'errors');
    expect(out.errors[0]?.message).toContain('does not exist');
  });
});

describe('applyPatch: Move File', () => {
  test('rename only (no hunks) copies content unchanged', () => {
    const patch = parsed(['*** Begin Patch', '*** Move File: a.ts -> b.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({ 'a.ts': 'body\n' }));
    assertHas(out, 'plan');
    expect(out.plan.moves.get('a.ts')).toBe('b.ts');
    expect(out.plan.writes.get('b.ts')).toBe('body\n');
  });

  test('hunks apply against the OLD path content (D5)', () => {
    const oldContent = ['fn() {', '  return "old";', '}', ''].join('\n');
    const patch = parsed(
      [
        '*** Begin Patch',
        '*** Move File: old.ts -> new.ts',
        '@@',
        ' fn() {',
        '-  return "old";',
        '+  return "new";',
        ' }',
        '*** End Patch',
      ].join('\n'),
    );
    const out = applyPatch(patch, makeFs({ 'old.ts': oldContent }));
    assertHas(out, 'plan');
    expect(out.plan.moves.get('old.ts')).toBe('new.ts');
    expect(out.plan.writes.get('new.ts')).toBe(['fn() {', '  return "new";', '}', ''].join('\n'));
    // The OLD path should NOT appear in writes — it's purely a move source.
    expect(out.plan.writes.has('old.ts')).toBe(false);
    // And no synthetic delete (the rename is the deletion).
    expect(out.plan.deletes.has('old.ts')).toBe(false);
  });

  test('missing source is rejected', () => {
    const patch = parsed(['*** Begin Patch', '*** Move File: a.ts -> b.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({}));
    assertHas(out, 'errors');
    expect(out.errors[0]?.message).toContain('source');
  });

  test('existing target is rejected', () => {
    const patch = parsed(['*** Begin Patch', '*** Move File: a.ts -> b.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({ 'a.ts': 'x', 'b.ts': 'y' }));
    assertHas(out, 'errors');
    expect(out.errors[0]?.message).toContain('target');
  });

  test('self-move (from == to) is rejected', () => {
    const patch = parsed(['*** Begin Patch', '*** Move File: a.ts -> a.ts', '*** End Patch'].join('\n'));
    const out = applyPatch(patch, makeFs({ 'a.ts': 'x' }));
    assertHas(out, 'errors');
    expect(out.errors[0]?.message).toContain('differ');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Atomicity
// ──────────────────────────────────────────────────────────────────────

describe('applyPatch: atomicity', () => {
  test('one bad op rejects the whole patch and reports every error', () => {
    const patch = parsed(
      [
        '*** Begin Patch',
        // good
        '*** Add File: ok.ts',
        '+ok',
        // bad: missing file for delete
        '*** Delete File: missing.ts',
        // bad: hunk that does not match
        '*** Update File: present.ts',
        '@@',
        ' totally',
        '-missing',
        '+lines',
        // good
        '*** Delete File: present.ts',
        '*** End Patch',
      ].join('\n'),
    );

    const out = applyPatch(patch, makeFs({ 'present.ts': 'real\ncontent\n' }));
    assertHas(out, 'errors');
    // Two failing ops contribute errors (Delete missing + Update hunk).
    // The Delete-after-Update on `present.ts` becomes a plan-conflict error
    // because the Update already claimed the path.
    expect(out.errors.length).toBeGreaterThanOrEqual(2);
    const opIndexes = out.errors.map((e) => e.opIndex);
    expect(opIndexes).toContain(1);
    expect(opIndexes).toContain(2);
  });

  test('plan conflict (two ops touching the same path) reports an error', () => {
    const patch = parsed(
      ['*** Begin Patch', '*** Add File: dup.ts', '+x', '*** Add File: dup.ts', '+y', '*** End Patch'].join('\n'),
    );
    const out = applyPatch(patch, makeFs({}));
    assertHas(out, 'errors');
    expect(out.errors.some((e) => e.message.includes('conflicts'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-op happy path
// ──────────────────────────────────────────────────────────────────────

describe('applyPatch: multi-op happy path', () => {
  test('produces writes + deletes + moves in one plan', () => {
    const patch = parsed(
      [
        '*** Begin Patch',
        '*** Add File: docs/new.md',
        '+# new',
        '*** Update File: src/feature.ts',
        '@@',
        ' export function feature() {',
        '-  return "old";',
        '+  return "new";',
        ' }',
        '*** Delete File: legacy.ts',
        '*** Move File: src/util.ts -> src/utils/index.ts',
        '*** End Patch',
      ].join('\n'),
    );

    const out = applyPatch(
      patch,
      makeFs({
        'src/feature.ts': ['export function feature() {', '  return "old";', '}', ''].join('\n'),
        'legacy.ts': 'gone\n',
        'src/util.ts': 'export const u = 1;\n',
      }),
    );

    assertHas(out, 'plan');
    expect(out.plan.writes.get('docs/new.md')).toBe('# new');
    expect(out.plan.writes.get('src/feature.ts')).toContain('return "new"');
    expect(out.plan.deletes.has('legacy.ts')).toBe(true);
    expect(out.plan.moves.get('src/util.ts')).toBe('src/utils/index.ts');
    expect(out.plan.writes.get('src/utils/index.ts')).toBe('export const u = 1;\n');
  });
});
