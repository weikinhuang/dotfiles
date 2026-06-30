/**
 * Tests for lib/node/pi/ext/external-editor.ts.
 *
 * Only the pure command-resolution policy is exercised here; the
 * `openInExternalEditor` round-trip shells out to a real editor and is left
 * to live smoke-testing (see external-editor's module doc).
 */

import { expect, test } from 'vitest';

import { formatKeyChord, resolveExternalEditorCommand } from '../../../../../lib/node/pi/ext/external-editor.ts';

test('resolveExternalEditorCommand: explicit override wins over env and default', () => {
  expect(resolveExternalEditorCommand({ explicit: 'code -w', visual: 'vim', editor: 'emacs' })).toBe('code -w');
});

test('resolveExternalEditorCommand: $VISUAL beats $EDITOR', () => {
  expect(resolveExternalEditorCommand({ visual: 'nvim', editor: 'vi' })).toBe('nvim');
});

test('resolveExternalEditorCommand: falls back to $EDITOR when no override or $VISUAL', () => {
  expect(resolveExternalEditorCommand({ editor: 'vi' })).toBe('vi');
});

test('resolveExternalEditorCommand: blank / whitespace values are skipped', () => {
  expect(resolveExternalEditorCommand({ explicit: '   ', visual: '', editor: 'vi' })).toBe('vi');
});

test('resolveExternalEditorCommand: platform default when nothing is set', () => {
  expect(resolveExternalEditorCommand({ platform: 'linux' })).toBe('nano');
  expect(resolveExternalEditorCommand({ platform: 'darwin' })).toBe('nano');
  expect(resolveExternalEditorCommand({ platform: 'win32' })).toBe('notepad');
});

test('formatKeyChord: title-cases each chord segment', () => {
  expect(formatKeyChord('ctrl+g')).toBe('Ctrl+G');
  expect(formatKeyChord('alt+enter')).toBe('Alt+Enter');
  expect(formatKeyChord('f2')).toBe('F2');
});

test('formatKeyChord: defaults to Ctrl+G when unbound', () => {
  expect(formatKeyChord(undefined)).toBe('Ctrl+G');
  expect(formatKeyChord('')).toBe('Ctrl+G');
});
