/**
 * Tests for lib/node/pi/path-expand.ts.
 */

import { describe, expect, test } from 'vitest';

import { expandTilde } from '../../../../lib/node/pi/path-expand.ts';

const HOME = '/home/alice';

describe('expandTilde', () => {
  test('expands a bare tilde to the home directory', () => {
    expect(expandTilde('~', HOME)).toBe(HOME);
  });

  test('expands a leading ~/ against the home directory', () => {
    expect(expandTilde('~/foo', HOME)).toBe(`${HOME}/foo`);
    expect(expandTilde('~/.env', HOME)).toBe(`${HOME}/.env`);
  });

  test('leaves absolute, relative, $HOME, and ~user paths unchanged', () => {
    expect(expandTilde('/abs/path', HOME)).toBe('/abs/path');
    expect(expandTilde('./foo', HOME)).toBe('./foo');
    expect(expandTilde('$HOME/foo', HOME)).toBe('$HOME/foo');
    expect(expandTilde('~alice/secret', HOME)).toBe('~alice/secret');
    expect(expandTilde('', HOME)).toBe('');
  });

  test('uses the supplied homedir, not the process home', () => {
    expect(expandTilde('~/x', '/other/home')).toBe('/other/home/x');
  });
});
