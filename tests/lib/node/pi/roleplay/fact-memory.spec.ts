import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fileFor, indexFileFor } from '../../../../../lib/node/pi/memory-paths.ts';
import { parseFrontmatter, serializeMemory } from '../../../../../lib/node/pi/memory-reducer.ts';
import { clearRoleplayFacts, serializeRoleplayFact } from '../../../../../lib/node/pi/roleplay/fact-memory.ts';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'roleplay-fact-memory-'));
  vi.stubEnv('PI_MEMORY_ROOT', join(cwd, 'memory'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});
function writeNote(id: string, cast?: string, session = 'session'): string {
  const input = {
    name: id,
    description: `${id} description`,
    body: `${id} body`,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };
  const path = fileFor('session', 'note', id, cwd, session);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cast ? serializeRoleplayFact({ ...input, cast }) : serializeMemory({ ...input, type: 'note' }));
  return path;
}
test('fact-memory: ownership preserves the ordinary memory file schema and body', () => {
  const path = writeNote('owned', 'cast:a');
  const raw = readFileSync(path, 'utf8');
  expect(raw).toContain('roleplayFactCast: "cast:a"');
  expect(parseFrontmatter(raw)?.frontmatter.name).toBe('owned');
  expect(parseFrontmatter(raw)?.body.trim()).toBe('owned body');
});
test('fact-memory: clearing a cast removes only its owned notes and rebuilds the index', () => {
  const a = writeNote('a', 'cast-a');
  const b = writeNote('b', 'cast-b');
  const unrelated = writeNote('user');
  const other = writeNote('other-session', 'cast-a', 'other');
  expect(clearRoleplayFacts(cwd, 'session', 'cast-a')).toBe(1);
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
  expect(existsSync(other)).toBe(true);
  const index = readFileSync(indexFileFor('session', cwd, 'session'), 'utf8');
  expect(index).not.toContain('a description');
  expect(index).toContain('b description');
  expect(index).toContain('user description');
});
test('fact-memory: untagged legacy notes are never inferred to be owned', () => {
  const legacy = writeNote('legacy');
  expect(clearRoleplayFacts(cwd, 'session', 'cast-a')).toBe(0);
  expect(existsSync(legacy)).toBe(true);
});
test('fact-memory: absent session, absent cast and repeated cleanup are harmless', () => {
  const owned = writeNote('a', 'cast-a');
  expect(clearRoleplayFacts(cwd, null, 'cast-a')).toBe(0);
  expect(clearRoleplayFacts(cwd, 'session', '')).toBe(0);
  expect(existsSync(owned)).toBe(true);
  expect(clearRoleplayFacts(cwd, 'session', 'cast-a')).toBe(1);
  expect(clearRoleplayFacts(cwd, 'session', 'cast-a')).toBe(0);
});
