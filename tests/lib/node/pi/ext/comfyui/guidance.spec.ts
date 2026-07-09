/**
 * Tests for lib/node/pi/ext/comfyui/guidance.ts: the shared guidance-file
 * reader that both the enhancer and refiner wirings delegate to.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { readGuidanceFiles } from '../../../../../../lib/node/pi/ext/comfyui/guidance.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comfyui-guidance-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('concatenates present files in order, joined by a blank line', () => {
  writeFileSync(join(dir, 'global.md'), '  global guidance  ');
  writeFileSync(join(dir, 'wf.md'), 'workflow guidance\n');
  expect(readGuidanceFiles([join(dir, 'global.md'), join(dir, 'wf.md')], dir)).toBe(
    'global guidance\n\nworkflow guidance',
  );
});

test('resolves a relative path against fromCwd', () => {
  writeFileSync(join(dir, 'guide.md'), 'relative body');
  expect(readGuidanceFiles(['guide.md'], dir)).toBe('relative body');
});

test('skips undefined / empty / whitespace-only entries', () => {
  writeFileSync(join(dir, 'only.md'), 'kept');
  expect(readGuidanceFiles([undefined, '   ', join(dir, 'only.md')], dir)).toBe('kept');
});

test('skips a missing / unreadable file rather than throwing', () => {
  writeFileSync(join(dir, 'present.md'), 'here');
  expect(readGuidanceFiles([join(dir, 'gone.md'), join(dir, 'present.md')], dir)).toBe('here');
});

test('returns an empty string when nothing resolves', () => {
  expect(readGuidanceFiles([undefined, join(dir, 'nope.md')], dir)).toBe('');
});
