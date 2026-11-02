/**
 * Regression: the roleplay fact ownership tag survives the memory
 * extension's `update` rewrite. config/pi/extensions/memory.ts re-serializes
 * an updated note with `serializeMemory({ ..., extra: readMemoryFrontmatter(...)?.extra })`;
 * this spec drives that same pair so an edited captured fact is still cleared
 * by `/roleplay newscene`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  clearScanCache,
  fileFor,
  indexFileFor,
  readMemoryFrontmatter,
} from '../../../../../../lib/node/pi/memory-paths.ts';
import { parseFrontmatter, serializeMemory } from '../../../../../../lib/node/pi/memory-reducer.ts';
import { clearRoleplayFacts, serializeRoleplayFact } from '../../../../../../lib/node/pi/roleplay/fact-memory.ts';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'roleplay-fact-review-'));
  vi.stubEnv('PI_MEMORY_ROOT', join(cwd, 'memory'));
  clearScanCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

test('fact-memory-review: a captured fact updated through the memory tool is still cleared by newscene', () => {
  const path = fileFor('session', 'note', 'allergy', cwd, 'sid');
  mkdirSync(dirname(path), { recursive: true });
  const base = { name: 'User allergic', description: 'shellfish', body: 'shellfish', created: '2026-01-01T00:00:00Z' };
  writeFileSync(path, serializeRoleplayFact({ ...base, cast: 'reef', updated: base.created }));

  // Control: an untouched owned note in a sibling session is cleared (setup is sound).
  const control = fileFor('session', 'note', 'control', cwd, 'sid2');
  mkdirSync(dirname(control), { recursive: true });
  writeFileSync(control, serializeRoleplayFact({ ...base, cast: 'reef', updated: base.created }));
  expect(clearRoleplayFacts(cwd, 'sid2', 'reef')).toBe(1);

  // Mirror memory.ts `update` (description edit): read the prior frontmatter, re-serialize with its extras.
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
  const prior = readMemoryFrontmatter(
    { id: 'allergy', scope: 'session', type: 'note', name: '', description: '' },
    cwd,
    'sid',
  );
  writeFileSync(
    path,
    serializeMemory({
      name: parsed?.frontmatter.name ?? '',
      description: 'shellfish and peanuts',
      type: 'note',
      body: parsed?.body ?? '',
      created: prior?.created,
      updated: '2026-01-02T00:00:00Z',
      ...(prior?.extra ? { extra: prior.extra } : {}),
    }),
  );
  expect(readFileSync(path, 'utf8')).toContain('roleplayFactCast: "reef"');
  clearScanCache();

  expect(clearRoleplayFacts(cwd, 'sid', 'reef')).toBe(1);
});

test('fact-memory-review: memory frontmatter extras round-trip and never shadow known keys', () => {
  const raw = serializeMemory({
    name: 'n',
    description: 'd',
    type: 'note',
    body: 'b',
    extra: { roleplayFactCast: 'a: b #c', 'odd key': [1, { x: 'y' }], name: 'ignored', gone: undefined },
  });
  const fm = parseFrontmatter(raw)?.frontmatter;
  expect(fm?.name).toBe('n');
  expect(fm?.extra).toEqual({ roleplayFactCast: 'a: b #c', 'odd key': [1, { x: 'y' }] });
  // A file without unknown keys carries no `extra` at all (existing callers see the same shape).
  expect(
    parseFrontmatter(serializeMemory({ name: 'n', description: 'd', type: 'note', body: 'b' }))?.frontmatter,
  ).toEqual({
    name: 'n',
    description: 'd',
    type: 'note',
  });
});

test('fact-memory-review: `only` narrows removal to listed owned notes and rebuilds the index', () => {
  const write = (id: string, cast?: string): string => {
    const path = fileFor('session', 'note', id, cwd, 'sid');
    mkdirSync(dirname(path), { recursive: true });
    const input = { name: id, description: `${id} description`, body: id, created: '2026-01-01T00:00:00Z' };
    writeFileSync(
      path,
      cast
        ? serializeRoleplayFact({ ...input, cast, updated: input.created })
        : serializeMemory({ ...input, type: 'note', updated: input.created }),
    );
    return path;
  };
  const stale = write('stale', 'reef');
  const kept = write('kept', 'reef');
  const foreign = write('foreign', 'other');
  const user = write('user');
  clearScanCache();

  // Listed but not owned by this cast (foreign / untagged) is never removed; unlisted owned survives.
  expect(clearRoleplayFacts(cwd, 'sid', 'reef', { only: new Set(['stale', 'foreign', 'user', 'missing']) })).toBe(1);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  expect(existsSync(user)).toBe(true);
  const index = readFileSync(indexFileFor('session', cwd, 'sid'), 'utf8');
  expect(index).not.toContain('stale description');
  expect(index).toContain('kept description');

  // An empty set removes nothing; omitting `only` keeps today's clear-all-owned behavior.
  clearScanCache();
  expect(clearRoleplayFacts(cwd, 'sid', 'reef', { only: new Set() })).toBe(0);
  clearScanCache();
  expect(clearRoleplayFacts(cwd, 'sid', 'reef')).toBe(1);
  expect(existsSync(kept)).toBe(false);
});
