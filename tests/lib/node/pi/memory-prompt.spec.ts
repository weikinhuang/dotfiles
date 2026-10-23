/**
 * Tests for lib/node/pi/memory-prompt.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { formatMemoryIndex, renderMemoryIndex } from '../../../../lib/node/pi/memory-prompt.ts';
import { emptyState } from '../../../../lib/node/pi/memory-reducer.ts';
import { type MemoryEntry, type MemoryState } from '../../../../lib/node/pi/memory-reducer.ts';

const entry = (
  id: string,
  scope: 'global' | 'project' | 'session',
  type: 'user' | 'feedback' | 'project' | 'reference' | 'note',
  name = id,
  description = `desc for ${id}`,
): MemoryEntry => ({ id, scope, type, name, description });

const mkState = (
  global: MemoryEntry[],
  project: MemoryEntry[],
  projectSlug: string | null = null,
  session: MemoryEntry[] = [],
  sessionId: string | null = null,
): MemoryState => ({
  index: { global, project, session },
  projectSlug,
  sessionId,
});

test('formatMemoryIndex: empty state returns null', () => {
  expect(formatMemoryIndex(emptyState())).toBeNull();
});

test('formatMemoryIndex: single global memory renders a ## Memory block', () => {
  const out = formatMemoryIndex(mkState([entry('tabs', 'global', 'user')], []));

  expect(out).not.toBeNull();
  expect(out).toMatch(/^## Memory\n/);
  expect(out).toContain('### Global');
  expect(out).toContain('**user**');
  expect(out).toContain('- `tabs` - desc for tabs');
  expect(out).not.toContain('### Project');
});

test('formatMemoryIndex: project scope includes slug in label', () => {
  const out = formatMemoryIndex(
    mkState([], [entry('release', 'project', 'project', 'Release plan', 'Freeze Thu')], '--tmp-foo--'),
  );

  expect(out).toContain('### Project (--tmp-foo--)');
  expect(out).toContain('- Release plan (`release`) - Freeze Thu');
});

test('formatMemoryIndex: both scopes rendered with headers', () => {
  const out = formatMemoryIndex(
    mkState(
      [entry('a', 'global', 'user'), entry('b', 'global', 'feedback')],
      [entry('c', 'project', 'reference')],
      '--x--',
    ),
  );

  expect(out).toContain('### Global');
  expect(out).toContain('**user**');
  expect(out).toContain('**feedback**');
  expect(out).toContain('### Project (--x--)');
  expect(out).toContain('**reference**');
});

test('formatMemoryIndex: session scope renders a labelled note block', () => {
  const out = formatMemoryIndex(
    mkState([], [], null, [entry('scratch', 'session', 'note', 'Scratch', 'in-progress refactor')], 'sid-42'),
  );

  expect(out).not.toBeNull();
  expect(out).toContain('### Session (sid-42)');
  expect(out).toContain('**note**');
  expect(out).toContain('- `scratch` - in-progress refactor');
});

test('formatMemoryIndex: session-only state still renders a block', () => {
  const out = formatMemoryIndex(mkState([], [], null, [entry('n', 'session', 'note')], 'sid'));

  expect(out).not.toBeNull();
  expect(out).toMatch(/^## Memory\n/);
  expect(out).toContain('### Session (sid)');
});

test('formatMemoryIndex: all three scopes rendered together', () => {
  const out = formatMemoryIndex(
    mkState(
      [entry('a', 'global', 'user')],
      [entry('b', 'project', 'project')],
      '--x--',
      [entry('c', 'session', 'note')],
      'sid',
    ),
  );

  expect(out).toContain('### Global');
  expect(out).toContain('### Project (--x--)');
  expect(out).toContain('### Session (sid)');
});

test('formatMemoryIndex: empty type sections are omitted', () => {
  const out = formatMemoryIndex(mkState([entry('a', 'global', 'user')], []));

  expect(out).toContain('**user**');
  expect(out).not.toContain('**feedback**');
});

test('formatMemoryIndex: appends a trailer pointing at the memory tool when untruncated', () => {
  const out = formatMemoryIndex(mkState([entry('a', 'global', 'user')], []));

  expect(out).toMatch(/memory.*read|action `read`/);
});

test('renderMemoryIndex: reports how many entries the cap left out', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(3);
  const many: MemoryEntry[] = [];
  for (let i = 0; i < 10; i++) many.push(entry(`p-${i}`, 'project', 'project', `project-${i}`, filler));
  const capped = renderMemoryIndex(mkState([], many, '--s--'), { maxChars: 500 });
  expect(capped?.skipped).toBeGreaterThan(0);
  expect(capped?.body).toContain(`(${capped?.skipped} more memory entry(ies) not shown`);
  expect(renderMemoryIndex(mkState([], many.slice(0, 1), '--s--'))?.skipped).toBe(0);
  expect(renderMemoryIndex(emptyState())).toBeNull();
});

test('formatMemoryIndex: soft cap truncation emits a count and trailer', () => {
  const globalEntries: MemoryEntry[] = [];
  for (let i = 0; i < 40; i++) {
    globalEntries.push(entry(`id-${i}`, 'global', 'user', `name-${i}`, 'lorem ipsum dolor sit amet '.repeat(4)));
  }
  const out = formatMemoryIndex(mkState(globalEntries, []), { maxChars: 600 });

  expect(out).not.toBeNull();
  // Trailer mentions more not shown.
  expect(out).toMatch(/\(\d+ more memory entry\(ies\) not shown/);
});

test('formatMemoryIndex: respects a minimum 500-char floor for the cap', () => {
  const out = formatMemoryIndex(mkState([entry('a', 'global', 'user', 'A', 'short')], []), { maxChars: 10 });

  expect(out).not.toBeNull();
  // At least one entry rendered - sanity that the floor kicked in.
  expect(out).toContain('- `a` - short');
});

test('formatMemoryIndex: tight budget keeps behavioural types before project facts', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(3);
  const projectFacts: MemoryEntry[] = [];
  for (let i = 0; i < 10; i++) {
    projectFacts.push(entry(`p-${i}`, 'project', 'project', `project-${i}`, filler));
  }
  const globalFeedback = [entry('rule', 'global', 'feedback', 'global-rule', filler)];
  const projectUser = [entry('pref', 'project', 'user', 'project-pref', filler)];
  const out = formatMemoryIndex(mkState(globalFeedback, [...projectUser, ...projectFacts], '--slug--'), {
    maxChars: 500,
  });

  expect(out).not.toBeNull();
  // feedback + user win the budget even though they live in different scopes.
  expect(out).toContain('global-rule');
  expect(out).toContain('project-pref');
  expect(out).toMatch(/\(\d+ more memory entry\(ies\) not shown/);
  expect(out).not.toContain('project-9');
  // Display order stays reader-friendly: Global before Project.
  expect(out!.indexOf('### Global')).toBeLessThan(out!.indexOf('### Project'));
});

test('formatMemoryIndex: within a type the more specific scope wins the budget', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(6);
  const globalFeedback = [entry('g', 'global', 'feedback', 'global-fb', filler)];
  const projectFeedback = [entry('p', 'project', 'feedback', 'project-fb', filler)];
  const out = formatMemoryIndex(mkState(globalFeedback, projectFeedback, '--s--'), { maxChars: 500 });

  expect(out).toContain('project-fb');
  expect(out).not.toContain('global-fb');
});

test('formatMemoryIndex: omits the name when it only restates the id', () => {
  const out = formatMemoryIndex(
    mkState(
      [entry('batch-linters', 'global', 'feedback', 'Batch linters', 'd1')],
      [entry('batch-linters-2', 'project', 'feedback', 'Batch linters', 'd2')],
      '--s--',
    ),
  );

  expect(out).toContain('- `batch-linters` - d1');
  expect(out).toContain('- Batch linters (`batch-linters-2`) - d2');
});

// ──────────────────────────────────────────────────────────────────────
// Staleness marker
// ──────────────────────────────────────────────────────────────────────

const STALE_NOW = new Date('2026-06-30T00:00:00Z');

const stamped = (e: MemoryEntry, updated: string): MemoryEntry => ({ ...e, created: updated, updated });

test('formatMemoryIndex: stale project entry past threshold gets a tiny (Nd) marker', () => {
  const old = stamped(entry('p', 'project', 'project', 'Old plan', 'decided long ago'), '2026-05-01T00:00:00Z');
  const out = formatMemoryIndex(mkState([], [old], '--x--'), { now: STALE_NOW, staleDays: 30 });

  // 60 days old → marker appended after the description.
  expect(out).toContain('- Old plan (`p`) - decided long ago (60d)');
});

test('formatMemoryIndex: fresh project entry is not marked', () => {
  const fresh = stamped(entry('p', 'project', 'project', 'Recent', 'just decided'), '2026-06-25T00:00:00Z');
  const out = formatMemoryIndex(mkState([], [fresh], '--x--'), { now: STALE_NOW, staleDays: 30 });

  expect(out).toContain('- Recent (`p`) - just decided');
  expect(out).not.toMatch(/\(\d+d\)/);
});

test('formatMemoryIndex: non-project types are never marked, however old', () => {
  const oldUser = stamped(entry('u', 'global', 'user', 'User', 'ancient'), '2025-01-01T00:00:00Z');
  const oldRef = stamped(entry('r', 'project', 'reference', 'Ref', 'ancient'), '2025-01-01T00:00:00Z');
  const oldNote = stamped(entry('n', 'session', 'note', 'Note', 'ancient'), '2025-01-01T00:00:00Z');
  const out = formatMemoryIndex(mkState([oldUser], [oldRef], '--x--', [oldNote], 'sid'), {
    now: STALE_NOW,
    staleDays: 30,
  });

  expect(out).not.toMatch(/\(\d+d\)/);
});

test('formatMemoryIndex: undated project entry is not marked', () => {
  const out = formatMemoryIndex(mkState([], [entry('p', 'project', 'project')], '--x--'), {
    now: STALE_NOW,
    staleDays: 30,
  });

  expect(out).not.toMatch(/\(\d+d\)/);
});

test('formatMemoryIndex: ample budget renders every scope in display order, untruncated', () => {
  const out = formatMemoryIndex(
    mkState(
      [entry('a', 'global', 'user')],
      [entry('b', 'project', 'project')],
      '--x--',
      [entry('c', 'session', 'note')],
      'sid',
    ),
    { maxChars: 5000 },
  );

  expect(out).not.toBeNull();
  expect(out).not.toMatch(/not shown/);
  const gIdx = out!.indexOf('### Global');
  const pIdx = out!.indexOf('### Project');
  const sIdx = out!.indexOf('### Session');
  expect(gIdx).toBeGreaterThanOrEqual(0);
  expect(pIdx).toBeGreaterThan(gIdx);
  expect(sIdx).toBeGreaterThan(pIdx);
});
