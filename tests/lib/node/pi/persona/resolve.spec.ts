/**
 * Tests for `lib/node/pi/mode/resolve.ts`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { type ResolveContext, resolveWriteRoots } from '../../../../../lib/node/pi/persona/resolve.ts';

const HOME = '/home/alice';
const CWD = '/repo';
const SLUG = 'dotfiles';

const ctx: ResolveContext = { cwd: CWD, homedir: HOME, projectSlug: SLUG };

test('resolveWriteRoots: empty array → empty array', () => {
  expect(resolveWriteRoots([], ctx)).toEqual([]);
});

test('resolveWriteRoots: tilde expansion preserves trailing slash', () => {
  expect(resolveWriteRoots(['~/notes/'], ctx)).toEqual(['/home/alice/notes/']);
});

test('resolveWriteRoots: ./plans/ → cwd/plans/', () => {
  expect(resolveWriteRoots(['./plans/'], ctx)).toEqual(['/repo/plans/']);
});

test('resolveWriteRoots: bare relative `plans/` → cwd/plans/', () => {
  expect(resolveWriteRoots(['plans/'], ctx)).toEqual(['/repo/plans/']);
});

test('resolveWriteRoots: {projectSlug} substitution', () => {
  expect(resolveWriteRoots(['journal/{projectSlug}/'], ctx)).toEqual(['/repo/journal/dotfiles/']);
});

test('resolveWriteRoots: tilde + nested ~/.pi/personas/<persona>-notes/ shape', () => {
  // Followup #6 in plans/persona-extension-followups.md - the
  // Exusiai-style "persona writes scratch notes under the user-global
  // persona dir" pattern. Validates tilde expansion through several
  // path segments without any {projectSlug} or cwd substitution.
  expect(resolveWriteRoots(['~/.pi/personas/exusiai-notes/'], ctx)).toEqual([
    '/home/alice/.pi/personas/exusiai-notes/',
  ]);
});

test('resolveWriteRoots: tilde + {projectSlug} compound', () => {
  // Same Exusiai shape but per-project: confirms tilde and
  // {projectSlug} substitution compose correctly.
  expect(resolveWriteRoots(['~/.pi/personas/{projectSlug}/notes/'], ctx)).toEqual([
    '/home/alice/.pi/personas/dotfiles/notes/',
  ]);
});

test('resolveWriteRoots: absolute path returned untouched (no trailing slash)', () => {
  expect(resolveWriteRoots(['/etc/foo'], ctx)).toEqual(['/etc/foo']);
});

test('resolveWriteRoots: absolute path with trailing slash preserved', () => {
  expect(resolveWriteRoots(['/etc/foo/'], ctx)).toEqual(['/etc/foo/']);
});

// ──────────────────────────────────────────────────────────────────────
// Symlink lock - D8 in plans/pi-mode-extension.md.
// resolveWriteRoots MUST NOT call realpath. The returned path should
// equal the LINK path, not the symlink target. Future readers: do not
// "fix" this by introducing realpathSync - see plan decision D8.
// ──────────────────────────────────────────────────────────────────────

let sandbox = '';

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pi-mode-resolve-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('resolveWriteRoots: does NOT follow symlinks (D8 - link path wins)', () => {
  // Real directory:   <sandbox>/real-plans/
  // Symlink:          <sandbox>/plans -> <sandbox>/real-plans
  // We pass the LINK path; the resolver must return the LINK path,
  // not the realpath of the target.
  const realDir = join(sandbox, 'real-plans');
  mkdirSync(realDir, { recursive: true });
  const linkDir = join(sandbox, 'plans');
  symlinkSync(realDir, linkDir, 'dir');

  const out = resolveWriteRoots([linkDir + '/'], { ...ctx, cwd: sandbox });

  expect(out).toEqual([linkDir + '/']);
  // Sanity: the realpath would be different - confirms the assertion above is meaningful.
  expect(realpathSync(linkDir)).toBe(realDir);
  expect(out[0]).not.toBe(realDir + '/');
});
