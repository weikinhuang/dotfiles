/**
 * Specs for the ASRT tmpdir resolver + host pre-creation helper.
 * `resolveAsrtTmpdir` mirrors ASRT's `CLAUDE_CODE_TMPDIR ||
 * CLAUDE_TMPDIR || '/tmp/claude'` precedence; `ensureAsrtTmpdir`
 * `mkdir -p`s it and is best-effort / never-throwing.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ensureAsrtTmpdir, resolveAsrtTmpdir } from '../../../../../lib/node/pi/sandbox/asrt-tmpdir.ts';

describe('resolveAsrtTmpdir', () => {
  test('defaults to /tmp/claude when nothing is set', () => {
    expect(resolveAsrtTmpdir({})).toBe('/tmp/claude');
  });

  test('prefers CLAUDE_CODE_TMPDIR over CLAUDE_TMPDIR', () => {
    expect(resolveAsrtTmpdir({ CLAUDE_CODE_TMPDIR: '/a', CLAUDE_TMPDIR: '/b' })).toBe('/a');
  });

  test('falls back to CLAUDE_TMPDIR when the current name is absent', () => {
    expect(resolveAsrtTmpdir({ CLAUDE_TMPDIR: '/b' })).toBe('/b');
  });

  test('empty-string values fall through (matches ASRT ||-chain)', () => {
    expect(resolveAsrtTmpdir({ CLAUDE_CODE_TMPDIR: '', CLAUDE_TMPDIR: '' })).toBe('/tmp/claude');
    expect(resolveAsrtTmpdir({ CLAUDE_CODE_TMPDIR: '', CLAUDE_TMPDIR: '/b' })).toBe('/b');
  });
});

describe('ensureAsrtTmpdir', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('creates a missing directory and returns its path', () => {
    const base = mkdtempSync(join(tmpdir(), 'asrt-tmpdir-'));
    created.push(base);
    const target = join(base, 'nested', 'claude');
    expect(existsSync(target)).toBe(false);
    expect(ensureAsrtTmpdir({ CLAUDE_CODE_TMPDIR: target })).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  test('is idempotent when the directory already exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'asrt-tmpdir-'));
    created.push(base);
    expect(ensureAsrtTmpdir({ CLAUDE_CODE_TMPDIR: base })).toBe(base);
    expect(existsSync(base)).toBe(true);
  });

  test('never throws on an unwritable target', () => {
    // A path under /dev/null can never be created; the helper must
    // swallow the error and still return the resolved path.
    const target = '/dev/null/cannot-create';
    expect(() => ensureAsrtTmpdir({ CLAUDE_CODE_TMPDIR: target })).not.toThrow();
    expect(ensureAsrtTmpdir({ CLAUDE_CODE_TMPDIR: target })).toBe(target);
  });
});
