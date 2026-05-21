/**
 * Specs for `parseFsFailures` + `greatestCommonParent`.
 *
 * `parseFsFailures` is the bridge between a sandbox-blocked bash
 * tool_result and the new reactive ask-callback dialog in
 * `config/pi/extensions/sandbox.ts`. The dialog is only ever offered
 * when this parser returns at least one write path, so the spec
 * covers the shapes pi will actually see in the wild:
 *
 *   - coreutils EACCES (`mkdir`, `touch`, `cp`, `mv`)
 *   - Node-style EACCES (npm install, vite write, esbuild)
 *   - bash redirection errors (`/path: Permission denied`)
 *   - read-side denies (`cat /etc/shadow`)
 *   - non-denial lines (must NOT pull paths)
 *   - missing absolute path (must NOT fabricate)
 *
 * `greatestCommonParent` is the path-collapsing helper the dialog
 * uses to turn a wall of `node_modules/foo/...`, `node_modules/bar/...`
 * denials into a single offer for `<cwd>/node_modules`.
 */

import { describe, expect, test } from 'vitest';

import { greatestCommonParent, parseFsFailures } from '../../../../../lib/node/pi/sandbox/fs-failures.ts';

describe('parseFsFailures', () => {
  test('returns empty arrays for empty input', () => {
    expect(parseFsFailures('')).toEqual({ writePaths: [], readPaths: [] });
  });

  test('returns empty arrays when no denial markers are present', () => {
    const stderr = 'npm warn deprecated foo@1.2.3\nbuilt in 4.2s\n';
    expect(parseFsFailures(stderr)).toEqual({ writePaths: [], readPaths: [] });
  });

  test('extracts a mkdir write denial from coreutils stderr', () => {
    const stderr = `mkdir: cannot create directory '/Users/u/proj/node_modules': Permission denied\n`;
    expect(parseFsFailures(stderr)).toEqual({
      writePaths: ['/Users/u/proj/node_modules'],
      readPaths: [],
    });
  });

  test('extracts a touch write denial', () => {
    const stderr = `touch: cannot touch '/repo/node_modules/.package-lock.json': Permission denied\n`;
    expect(parseFsFailures(stderr).writePaths).toEqual(['/repo/node_modules/.package-lock.json']);
  });

  test('extracts Node EACCES style errors with `path:` shape', () => {
    const stderr = [
      'npm error code EACCES',
      'npm error syscall mkdir',
      "npm error path: '/repo/node_modules'",
      'npm error errno -13',
    ].join('\n');
    const out = parseFsFailures(stderr);
    expect(out.writePaths).toContain('/repo/node_modules');
  });

  test('extracts EACCES inline with op + quoted path', () => {
    const stderr = `Error: EACCES: permission denied, mkdir '/repo/dist'\n`;
    expect(parseFsFailures(stderr).writePaths).toEqual(['/repo/dist']);
  });

  test('handles EPERM operation-not-permitted shapes', () => {
    const stderr = `Error: EPERM: operation not permitted, open '/repo/.git/config'\n`;
    expect(parseFsFailures(stderr).writePaths).toEqual(['/repo/.git/config']);
  });

  test('bash redirection: classifies as write', () => {
    const stderr = `bash: /etc/foo.conf: Permission denied\n`;
    const out = parseFsFailures(stderr);
    // `bash: <path>: Permission denied` has no verb; defaults to write,
    // which matches what's actually happening (shell redirection).
    expect(out.writePaths).toEqual(['/etc/foo.conf']);
    expect(out.readPaths).toEqual([]);
  });

  test('read denial is classified as read when the line says so', () => {
    const stderr = `cat: /etc/shadow: Permission denied\n`;
    const out = parseFsFailures(stderr);
    expect(out.readPaths).toEqual(['/etc/shadow']);
    expect(out.writePaths).toEqual([]);
  });

  test('read-only filesystem is treated as a write denial', () => {
    const stderr = `mkdir: cannot create directory '/usr/foo': Read-only file system\n`;
    expect(parseFsFailures(stderr).writePaths).toEqual(['/usr/foo']);
  });

  test('deduplicates the same path across multiple denial lines', () => {
    const stderr = [
      `mkdir: cannot create directory '/repo/node_modules/foo': Permission denied`,
      `mkdir: cannot create directory '/repo/node_modules/foo': Permission denied`,
      `npm error EACCES: permission denied, mkdir '/repo/node_modules/foo'`,
    ].join('\n');
    expect(parseFsFailures(stderr).writePaths).toEqual(['/repo/node_modules/foo']);
  });

  test('preserves order of first occurrence across distinct paths', () => {
    const stderr = [
      `mkdir: cannot create directory '/a/x': Permission denied`,
      `mkdir: cannot create directory '/a/y': Permission denied`,
      `mkdir: cannot create directory '/a/x': Permission denied`,
    ].join('\n');
    expect(parseFsFailures(stderr).writePaths).toEqual(['/a/x', '/a/y']);
  });

  test('skips lines without an absolute path even when a marker is present', () => {
    const stderr = `Permission denied (publickey).\n`; // ssh-style, no path
    expect(parseFsFailures(stderr)).toEqual({ writePaths: [], readPaths: [] });
  });

  test('ignores relative paths (no /-prefix)', () => {
    const stderr = `mkdir: cannot create directory 'dist': Permission denied\n`;
    expect(parseFsFailures(stderr)).toEqual({ writePaths: [], readPaths: [] });
  });

  test('handles double-quoted paths', () => {
    const stderr = `Error: EACCES: permission denied, open "/repo/with space/foo.txt"\n`;
    expect(parseFsFailures(stderr).writePaths).toEqual(['/repo/with space/foo.txt']);
  });

  test('mixed write + read denials in the same stderr are split', () => {
    const stderr = [
      `mkdir: cannot create directory '/repo/dist': Permission denied`,
      `cat: /etc/shadow: Permission denied`,
    ].join('\n');
    const out = parseFsFailures(stderr);
    expect(out.writePaths).toEqual(['/repo/dist']);
    expect(out.readPaths).toEqual(['/etc/shadow']);
  });
});

describe('greatestCommonParent', () => {
  test('returns the input path verbatim for a single entry', () => {
    expect(greatestCommonParent(['/repo/node_modules/foo'])).toBe('/repo/node_modules/foo');
  });

  test('collapses multiple sibling paths to their common parent', () => {
    expect(
      greatestCommonParent([
        '/repo/node_modules/foo/index.js',
        '/repo/node_modules/bar/package.json',
        '/repo/node_modules/baz',
      ]),
    ).toBe('/repo/node_modules');
  });

  test('does NOT collapse on substring matches (segment-wise compare)', () => {
    // `/usr/local` and `/usr/locale` share a prefix character but
    // their second segment differs, so the parent must be /usr.
    expect(greatestCommonParent(['/usr/local/foo', '/usr/locale/bar'])).toBe('/usr');
  });

  test('returns / when inputs disagree on the very first segment', () => {
    expect(greatestCommonParent(['/etc/foo', '/var/bar'])).toBe('/');
  });

  test('empty input returns empty string', () => {
    expect(greatestCommonParent([])).toBe('');
  });
});
