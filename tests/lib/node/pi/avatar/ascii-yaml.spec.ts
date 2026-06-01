/**
 * Tests for lib/node/pi/avatar/ascii-yaml.ts.
 */

import { describe, expect, test } from 'vitest';

import { mergeAsciiFrameMaps, parseSimpleYaml } from '../../../../../lib/node/pi/avatar/ascii-yaml.ts';

describe('parseSimpleYaml', () => {
  test('parses inline scalars', () => {
    expect(parseSimpleYaml('failure: "( x )"')).toEqual({ failure: '( x )' });
  });

  test('parses one-level named maps', () => {
    const out = parseSimpleYaml(['idle:', '  default: "(o o)"', '  blink:   "(- -)"'].join('\n'));
    expect(out).toEqual({ idle: { default: '(o o)', blink: '(- -)' } });
  });

  test('parses arrays of scalars', () => {
    const out = parseSimpleYaml(['read:', '  - "a"', '  - "b"'].join('\n'));
    expect(out).toEqual({ read: ['a', 'b'] });
  });

  test('ignores comments and blank lines', () => {
    const out = parseSimpleYaml(['# header', '', 'hi: "(^_^)"', '   '].join('\n'));
    expect(out).toEqual({ hi: '(^_^)' });
  });

  test('handles multiple states in one document', () => {
    const out = parseSimpleYaml(['hi: "a"', 'talk:', '  close: "b"', 'tool:', '  - "c"', '  - "d"'].join('\n'));
    expect(out).toEqual({ hi: 'a', talk: { close: 'b' }, tool: ['c', 'd'] });
  });
});

describe('mergeAsciiFrameMaps', () => {
  test('returns an empty map for no layers', () => {
    expect(mergeAsciiFrameMaps([])).toEqual({});
  });

  test('keeps base keys an overlay does not touch', () => {
    const merged = mergeAsciiFrameMaps([{ happy: 'a', sad: 'b' }, { purr: 'c' }]);
    expect(merged).toEqual({ happy: 'a', sad: 'b', purr: 'c' });
  });

  test('later layers override earlier keys', () => {
    const merged = mergeAsciiFrameMaps([{ happy: 'base' }, { happy: 'overlay' }]);
    expect(merged.happy).toBe('overlay');
  });

  test('does not mutate the input maps', () => {
    const base = { happy: 'a' };
    const overlay = { happy: 'b' };
    mergeAsciiFrameMaps([base, overlay]);
    expect(base).toEqual({ happy: 'a' });
    expect(overlay).toEqual({ happy: 'b' });
  });
});
