/**
 * Tests for lib/node/pi/statusline/segments.ts.
 *
 * Pure display-string builders - golden-output assertions on the raw
 * ANSI / OSC8 sequences so a palette or wrapper drift is caught here.
 */

import { expect, test } from 'vitest';

import {
  BOLD,
  cwdFileUrl,
  osc8,
  paint,
  PALETTE,
  RESET,
  renderSandboxBadge,
} from '../../../../../lib/node/pi/statusline/segments.ts';

test('paint wraps text in the SGR code + reset', () => {
  expect(paint(PALETTE.dir, 'src')).toBe('\x1b[38;5;142msrc\x1b[0m');
  expect(RESET).toBe('\x1b[0m');
  expect(BOLD).toBe('\x1b[1m');
});

test('osc8 emits the OSC 8 hyperlink escape', () => {
  expect(osc8('file:///a', 'label')).toBe('\x1b]8;;file:///a\x1b\\label\x1b]8;;\x1b\\');
});

test('renderSandboxBadge golden output per mode', () => {
  expect(renderSandboxBadge('wrapped')).toBe('\x1b[38;5;72m\u{1F6E1}\uFE0F \x1b[0m');
  expect(renderSandboxBadge('identity')).toBe('\x1b[38;5;172m\u{1F6E1}\uFE0F ?\x1b[0m');
  expect(renderSandboxBadge('env-disabled')).toBe('\x1b[38;5;160m\u{1F6E1}\uFE0F \u00b7off\x1b[0m');
  expect(renderSandboxBadge('bypassed')).toBeNull();
  expect(renderSandboxBadge('off')).toBeNull();
});

test('cwdFileUrl: disabled / empty cwd → null', () => {
  expect(cwdFileUrl('/repo', false, {})).toBeNull();
  expect(cwdFileUrl('', true, {})).toBeNull();
});

test('cwdFileUrl: plain local path', () => {
  expect(cwdFileUrl('/home/me/repo', true, {})).toBe('file:///home/me/repo');
});

test('cwdFileUrl: remote SSH session → null', () => {
  expect(cwdFileUrl('/home/me/repo', true, { SSH_TTY: '/dev/pts/0' })).toBeNull();
});

test('cwdFileUrl: WSL /mnt path maps to a drive URL', () => {
  expect(cwdFileUrl('/mnt/c/Users/me', true, { WSL_DISTRO_NAME: 'Ubuntu' })).toBe('file:///C:/Users/me');
});

test('cwdFileUrl: WSL non-mnt path maps to the wsl.localhost view', () => {
  expect(cwdFileUrl('/home/me', true, { WSL_DISTRO_NAME: 'Ubuntu' })).toBe('file://wsl.localhost/Ubuntu/home/me');
});
