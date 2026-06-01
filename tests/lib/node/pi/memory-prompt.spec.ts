/**
 * Tests for lib/node/pi/memory-prompt.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { formatMemoryIndex } from '../../../../lib/node/pi/memory-prompt.ts';
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
  expect(out).toContain('- tabs (`tabs`) - desc for tabs');
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
  expect(out).toContain('- Scratch (`scratch`) - in-progress refactor');
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
  expect(out).toContain('- A (`a`)');
});
