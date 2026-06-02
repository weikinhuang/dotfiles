/**
 * Tests for lib/node/pi/commands/complete.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  completePositional,
  completeSubverbs,
  type SubverbSpec,
} from '../../../../../lib/node/pi/commands/complete.ts';

const SPEC: SubverbSpec = {
  on: {
    description: 'enable',
    args: (tail) => ['alpha', 'beta', 'gamma'].filter((s) => s.startsWith(tail)).map((label) => ({ label })),
  },
  off: { description: 'disable', args: ['alpha', 'beta'] },
  list: { description: 'show all' },
};

describe('completeSubverbs', () => {
  test('empty prefix returns all verbs', () => {
    const out = completeSubverbs('', SPEC);
    expect(out?.map((c) => c.value)).toEqual(['on', 'off', 'list']);
    expect(out?.[0].description).toBe('enable');
  });

  test('partial prefix filters verbs by startsWith', () => {
    const out = completeSubverbs('o', SPEC);
    expect(out?.map((c) => c.value)).toEqual(['on', 'off']);
  });

  test('unknown level-1 token returns null', () => {
    expect(completeSubverbs('zzz', SPEC)).toBeNull();
  });

  test('level-2 resolver output is filtered by tail', () => {
    const out = completeSubverbs('on a', SPEC);
    expect(out?.map((c) => c.label)).toEqual(['alpha']);
  });

  test('level-2 value carries the verb prefix; label stays bare', () => {
    const out = completeSubverbs('on al', SPEC);
    expect(out).toEqual([{ value: 'on alpha', label: 'alpha', description: undefined }]);
  });

  test('level-2 works with a static string[] arg list', () => {
    const out = completeSubverbs('off ', SPEC);
    expect(out?.map((c) => c.value)).toEqual(['off alpha', 'off beta']);
  });

  test('terminal verb (no args) at level 2 returns null', () => {
    expect(completeSubverbs('list ', SPEC)).toBeNull();
  });

  test('unknown verb at level 2 returns null', () => {
    expect(completeSubverbs('zzz foo', SPEC)).toBeNull();
  });

  test('no level-2 match returns null', () => {
    expect(completeSubverbs('on qqq', SPEC)).toBeNull();
  });

  test('honours an explicit value override on a candidate', () => {
    const spec: SubverbSpec = {
      show: { args: () => [{ label: 'My Agent', value: 'my-agent', description: 'an agent' }] },
    };
    const out = completeSubverbs('show my', spec);
    expect(out).toEqual([{ value: 'show my-agent', label: 'My Agent', description: 'an agent' }]);
  });
});

describe('completePositional', () => {
  test('returns bare tokens as value (no verb prefix)', () => {
    const out = completePositional('exa', (tail) =>
      ['example.com', 'other.org'].filter((d) => d.startsWith(tail)).map((label) => ({ label })),
    );
    expect(out).toEqual([{ value: 'example.com', label: 'example.com', description: undefined }]);
  });

  test('empty prefix returns all candidates', () => {
    const out = completePositional('', () => [{ label: 'a' }, { label: 'b' }]);
    expect(out?.map((c) => c.value)).toEqual(['a', 'b']);
  });

  test('no match returns null', () => {
    expect(completePositional('zzz', () => [{ label: 'a' }])).toBeNull();
  });

  test('matches against the whole prefix, not the last whitespace token', () => {
    const resolve = (): { label: string }[] => [{ label: 'git status' }, { label: 'git log' }];
    const out = completePositional('git s', resolve);
    expect(out).toEqual([{ value: 'git status', label: 'git status', description: undefined }]);
  });
});
