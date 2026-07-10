/**
 * Tests for lib/node/pi/roleplay/prompt-override.ts: the layered
 * guidance-override resolver (project scope over user scope, first
 * non-empty file wins, kill switch forces null).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { resolvePromptGuidance, resolvePromptOverride } from '../../../../../lib/node/pi/roleplay/prompt-override.ts';

let cwd: string;
let root: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rp-prompt-cwd-'));
  root = mkdtempSync(join(tmpdir(), 'rp-prompt-root-'));
  delete process.env.PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES;
});

function writeProject(name: string, body: string): string {
  const dir = join(cwd, '.pi', 'roleplay', 'prompts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body);
  return path;
}

function writeUser(name: string, body: string): string {
  const dir = join(root, 'prompts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body);
  return path;
}

test('returns null when no override file exists', () => {
  expect(resolvePromptOverride('summary', { cwd, root })).toBeNull();
  expect(resolvePromptGuidance('timeline', { cwd, root })).toBeUndefined();
});

test('reads the user-scope file when only it exists', () => {
  const path = writeUser('timeline', 'only pull combat beats');
  expect(resolvePromptOverride('timeline', { cwd, root })).toEqual({
    text: 'only pull combat beats',
    source: path,
  });
});

test('project scope wins over user scope', () => {
  writeUser('summary', 'user guidance');
  const projectPath = writeProject('summary', 'project guidance');
  expect(resolvePromptOverride('summary', { cwd, root })).toEqual({
    text: 'project guidance',
    source: projectPath,
  });
});

test('trims whitespace and returns the trimmed text', () => {
  writeProject('facts', '  \n  keep only allergies  \n  ');
  expect(resolvePromptGuidance('facts', { cwd, root })).toBe('keep only allergies');
});

test('a whitespace-only file is skipped (falls through to null / next layer)', () => {
  writeProject('event', '   \n\t  ');
  const userPath = writeUser('event', 'user event guidance');
  // Blank project file is skipped; user layer wins.
  expect(resolvePromptOverride('event', { cwd, root })).toEqual({
    text: 'user event guidance',
    source: userPath,
  });
});

test('a whitespace-only file with no lower layer resolves to null', () => {
  writeProject('summary', '   ');
  expect(resolvePromptOverride('summary', { cwd, root })).toBeNull();
});

test('kill switch forces null even when a file exists', () => {
  writeProject('timeline', 'custom guidance');
  process.env.PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES = '1';
  expect(resolvePromptOverride('timeline', { cwd, root })).toBeNull();
  expect(resolvePromptGuidance('timeline', { cwd, root })).toBeUndefined();
});

test('each prompt name resolves its own file independently', () => {
  writeProject('summary', 'S');
  writeProject('timeline', 'T');
  writeProject('facts', 'F');
  writeProject('event', 'E');
  expect(resolvePromptGuidance('summary', { cwd, root })).toBe('S');
  expect(resolvePromptGuidance('timeline', { cwd, root })).toBe('T');
  expect(resolvePromptGuidance('facts', { cwd, root })).toBe('F');
  expect(resolvePromptGuidance('event', { cwd, root })).toBe('E');
});
