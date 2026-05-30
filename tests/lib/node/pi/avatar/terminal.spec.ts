/**
 * Tests for lib/node/pi/avatar/terminal.ts.
 */

import { describe, expect, test } from 'vitest';

import { detectProtocol, resolveProtocol } from '../../../../../lib/node/pi/avatar/terminal.ts';

describe('detectProtocol', () => {
  test('kitty via KITTY_WINDOW_ID', () => {
    expect(detectProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
  });

  test('kitty via ghostty markers', () => {
    expect(detectProtocol({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe('kitty');
    expect(detectProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
  });

  test('iterm2 via ITERM_SESSION_ID or TERM_PROGRAM', () => {
    expect(detectProtocol({ ITERM_SESSION_ID: 'w0' })).toBe('iterm2');
    expect(detectProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });

  test('iterm2 protocol for wezterm', () => {
    expect(detectProtocol({ WEZTERM_PANE: '0' })).toBe('iterm2');
    expect(detectProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('iterm2');
  });

  test('sixel for Windows Terminal via WT_SESSION', () => {
    expect(detectProtocol({ WT_SESSION: 'abc-123' })).toBe('sixel');
  });

  test('kitty / iterm2 win over Windows Terminal when both are present', () => {
    expect(detectProtocol({ WT_SESSION: 'x', KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectProtocol({ WT_SESSION: 'x', ITERM_SESSION_ID: 'w0' })).toBe('iterm2');
  });

  test('tmux/screen force ascii even with a capable outer terminal', () => {
    expect(detectProtocol({ TMUX: '/tmp/sock', KITTY_WINDOW_ID: '1' })).toBe('ascii');
    expect(detectProtocol({ TERM: 'screen-256color', ITERM_SESSION_ID: 'w0' })).toBe('ascii');
    expect(detectProtocol({ TERM: 'tmux-256color' })).toBe('ascii');
    expect(detectProtocol({ TMUX: '/tmp/sock', WT_SESSION: 'x' })).toBe('ascii');
  });

  test('unknown terminal falls back to ascii', () => {
    expect(detectProtocol({})).toBe('ascii');
    expect(detectProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('ascii');
  });

  test('halfblock is opt-in only - never returned by auto-detection', () => {
    expect(detectProtocol({})).not.toBe('halfblock');
    expect(detectProtocol({ KITTY_WINDOW_ID: '1' })).not.toBe('halfblock');
    expect(detectProtocol({ WT_SESSION: 'x' })).not.toBe('halfblock');
    expect(detectProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).not.toBe('halfblock');
  });
});

describe('resolveProtocol', () => {
  test('concrete override wins over detection', () => {
    expect(resolveProtocol('ascii', { KITTY_WINDOW_ID: '1' })).toBe('ascii');
    expect(resolveProtocol('iterm2', { KITTY_WINDOW_ID: '1' })).toBe('iterm2');
    expect(resolveProtocol('kitty', {})).toBe('kitty');
    expect(resolveProtocol('sixel', { KITTY_WINDOW_ID: '1' })).toBe('sixel');
    expect(resolveProtocol('halfblock', { KITTY_WINDOW_ID: '1' })).toBe('halfblock');
    expect(resolveProtocol('halfblock', {})).toBe('halfblock');
  });

  test('auto (or unknown) defers to detection', () => {
    expect(resolveProtocol('auto', { KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(resolveProtocol('nonsense', { ITERM_SESSION_ID: 'w0' })).toBe('iterm2');
    expect(resolveProtocol('auto', {})).toBe('ascii');
  });
});
