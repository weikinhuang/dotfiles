/**
 * Tests for `lib/node/pi/mode/match.ts`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { isInsideWriteRoots } from '../../../../../lib/node/pi/persona/match.ts';

test('isInsideWriteRoots: empty roots → false', () => {
  expect(isInsideWriteRoots('/repo/plans/foo.md', [])).toBe(false);
});

test('isInsideWriteRoots: exact match (input has no trailing slash)', () => {
  expect(isInsideWriteRoots('/repo/plans', ['/repo/plans/'])).toBe(true);
});

test('isInsideWriteRoots: exact match (both have trailing slash)', () => {
  expect(isInsideWriteRoots('/repo/plans/', ['/repo/plans/'])).toBe(true);
});

test('isInsideWriteRoots: nested path → true', () => {
  expect(isInsideWriteRoots('/repo/plans/v1/foo.md', ['/repo/plans/'])).toBe(true);
});

test('isInsideWriteRoots: sibling rejected (prefix-trap defense)', () => {
  expect(isInsideWriteRoots('/repo/plans-old/foo.md', ['/repo/plans/'])).toBe(false);
});

test('isInsideWriteRoots: `..` escape resolved before comparison', () => {
  // /repo/plans/../etc/passwd resolves to /repo/etc/passwd
  expect(isInsideWriteRoots('/repo/plans/../etc/passwd', ['/repo/plans/'])).toBe(false);
});

test('isInsideWriteRoots: root without trailing slash still works for nested', () => {
  expect(isInsideWriteRoots('/repo/plans/foo.md', ['/repo/plans'])).toBe(true);
  expect(isInsideWriteRoots('/repo/plans-old/foo.md', ['/repo/plans'])).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Symlink-escape lock - D8 in plans/pi-mode-extension.md.
//
// isInsideWriteRoots operates on path strings only. A symlink whose
// target is OUTSIDE the root must still count as INSIDE when the LINK
// path lives inside the root. The link path is what matters - the
// target is irrelevant. Future readers: do NOT "fix" this by adding
// realpath; the lock is intentional. See plan decision D8.
// ──────────────────────────────────────────────────────────────────────

let sandbox = '';

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pi-mode-match-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('isInsideWriteRoots: symlink target NOT followed (D8 - link path wins)', () => {
  // <sandbox>/plans/leak  → symlink to /etc/passwd (target outside root)
  const plansDir = join(sandbox, 'plans');
  mkdirSync(plansDir, { recursive: true });

  // Pick a target that exists on the host but lies outside <sandbox>/plans/.
  // We fall back to creating a real outside-target file to avoid host coupling.
  const outsideTarget = join(sandbox, 'outside.txt');
  writeFileSync(outsideTarget, 'leak\n');

  const linkPath = join(plansDir, 'leak');
  symlinkSync(outsideTarget, linkPath);

  // Link path is inside the root ⇒ true. (If we ever followed symlinks,
  // this would resolve to <sandbox>/outside.txt and be false.)
  expect(isInsideWriteRoots(linkPath, [plansDir + '/'])).toBe(true);
});
