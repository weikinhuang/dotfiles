/**
 * Tests for lib/node/pi/avatar/tmux.ts.
 */

import { describe, expect, test } from 'vitest';

import { isInTmux, wrapForTmux } from '../../../../../lib/node/pi/avatar/tmux.ts';

const ESC = '\x1b';
const KITTY_PREFIX = `${ESC}_G`;
const ITERM_PREFIX = `${ESC}]1337;File=`;

describe('isInTmux', () => {
  test('true when $TMUX is set', () => {
    expect(isInTmux({ TMUX: '/tmp/tmux-1000/default,12345,0' })).toBe(true);
  });

  test('true when $TERM looks like tmux or screen', () => {
    expect(isInTmux({ TERM: 'tmux-256color' })).toBe(true);
    expect(isInTmux({ TERM: 'screen.xterm-256color' })).toBe(true);
    expect(isInTmux({ TERM: 'SCREEN' })).toBe(true);
  });

  test('false for ordinary terminals', () => {
    expect(isInTmux({})).toBe(false);
    expect(isInTmux({ TERM: 'xterm-256color' })).toBe(false);
    expect(isInTmux({ TMUX: '' })).toBe(false);
  });
});

describe('wrapForTmux', () => {
  test('wraps in the tmux DCS envelope', () => {
    const out = wrapForTmux('hello');
    expect(out.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(out.endsWith(`${ESC}\\`)).toBe(true);
    expect(out).toBe(`${ESC}Ptmux;hello${ESC}\\`);
  });

  test('doubles every inner ESC', () => {
    const inner = `${ESC}_Gm=0;${ESC}\\`;
    const out = wrapForTmux(inner);
    expect(out).toBe(`${ESC}Ptmux;${ESC}${ESC}_Gm=0;${ESC}${ESC}\\${ESC}\\`);
  });

  test('round-trips: strip envelope and halve inner ESCs', () => {
    const inner = `${ESC}_Gf=100,a=T;BASE64\x07`;
    const wrapped = wrapForTmux(inner);
    const body = wrapped.slice(`${ESC}Ptmux;`.length, -`${ESC}\\`.length);
    const halved = body.replaceAll(`${ESC}${ESC}`, ESC);
    expect(halved).toBe(inner);
  });

  test('wrapped kitty / iTerm2 lines preserve the pi-tui image markers as substrings', () => {
    // pi-tui's isImageLine() does `includes('\x1b_G')` / `includes('\x1b]1337;File=')`;
    // the doubled-ESC encoding leaves both prefixes intact as substrings.
    expect(wrapForTmux(`${ESC}_Gf=100;abc${ESC}\\`)).toContain(KITTY_PREFIX);
    expect(wrapForTmux(`${ESC}]1337;File=name=x:BASE64\x07`)).toContain(ITERM_PREFIX);
  });

  test('payload without escapes wraps verbatim', () => {
    expect(wrapForTmux('plain')).toBe(`${ESC}Ptmux;plain${ESC}\\`);
  });
});
