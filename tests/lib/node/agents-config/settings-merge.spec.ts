import { describe, expect, test } from 'vitest';

import {
  formatValue,
  JSON_CODEC,
  mergeSettings,
  redactValue,
  renderSettingsChange,
  type SettingsChange,
  valuesEqual,
} from '../../../../lib/node/agents-config/settings-merge.ts';

function render(changes: SettingsChange[]): string[] {
  return changes.flatMap(renderSettingsChange);
}

describe('mergeSettings', () => {
  test('baseline keys overwrite, live-only keys survive, live order is kept and new keys are appended', () => {
    const live = { model: 'local', theme: 'dark', nested: { mine: 1, owned: 'old' }, lastVersion: '1.2' };
    const baseline = { theme: 'auto', nested: { owned: 'new', extra: true }, effortLevel: 'high' };
    const { merged, changes } = mergeSettings(baseline, live);
    expect(merged).toEqual({
      model: 'local',
      theme: 'auto',
      nested: { mine: 1, owned: 'new', extra: true },
      lastVersion: '1.2',
      effortLevel: 'high',
    });
    expect(Object.keys(merged)).toEqual(['model', 'theme', 'nested', 'lastVersion', 'effortLevel']);
    expect(Object.keys(merged.nested as object)).toEqual(['mine', 'owned', 'extra']);
    expect(render(changes)).toEqual([
      '~ theme: "dark" -> "auto"',
      '~ nested.owned: "old" -> "new"',
      '+ nested.extra: true',
      '+ effortLevel: "high"',
    ]);
  });

  test('arrays are replaced whole and the diff lists removed and added entries', () => {
    const { merged, changes } = mergeSettings({ allow: ['a', 'b', 'c'] }, { allow: ['a', 'x'] });
    expect(merged.allow).toEqual(['a', 'b', 'c']);
    expect(render(changes)).toEqual(['~ allow: array, 1 removed, 2 added', '    - "x"', '    + "b"', '    + "c"']);
  });

  test('a reordered array is a change; an equal one is not', () => {
    expect(render(mergeSettings({ a: [1, 2] }, { a: [2, 1] }).changes)).toEqual(['~ a: array reordered']);
    expect(mergeSettings({ a: [1, 2], o: { k: [{ x: 1 }] } }, { o: { k: [{ x: 1 }] }, a: [1, 2] }).changes).toEqual([]);
  });

  test('a new object key is reported leaf by leaf; a new array key lists its entries', () => {
    const { changes } = mergeSettings({ footer: { a: true, b: { c: 1 } }, list: ['x'] }, {});
    expect(render(changes)).toEqual(['+ footer.a: true', '+ footer.b.c: 1', '+ list: array of 1', '    + "x"']);
  });

  test('a type change replaces the live value', () => {
    const { merged, changes } = mergeSettings({ a: { b: 1 }, c: [1] }, { a: 'scalar', c: 'x' });
    expect(merged).toEqual({ a: { b: 1 }, c: [1] });
    expect(render(changes)).toEqual(['~ a: "scalar" -> {"b": 1}', '~ c: "x" -> [1]']);
  });

  test('null-prototype objects (TOML parser output) deep-merge', () => {
    const live = Object.assign(Object.create(null) as Record<string, unknown>, { t: { keep: 1n } });
    const { merged, changes } = mergeSettings({ t: { add: 2n } }, live);
    expect(merged).toEqual({ t: { keep: 1n, add: 2n } });
    expect(render(changes)).toEqual(['+ t.add: 2']);
  });
});

describe('redaction', () => {
  test('values under secret-looking keys never render', () => {
    const { changes } = mergeSettings(
      { env: { API_TOKEN: 'new-secret', PLAIN: '1' }, authHeader: 'x', servers: [{ name: 'a', apiKey: 'k' }] },
      { env: { API_TOKEN: 'old-secret', PLAIN: '0' } },
    );
    const text = render(changes).join('\n');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('"k"');
    expect(text).toContain('~ env.API_TOKEN: <redacted> -> <redacted>');
    expect(text).toContain('~ env.PLAIN: "0" -> "1"');
    expect(text).toContain('+ authHeader: <redacted>');
    expect(text).toContain('+ {"name": "a", "apiKey": "<redacted>"}');
  });

  test('keys that merely contain "auth" or "key" stay visible', () => {
    const { changes } = mergeSettings(
      { includeCoAuthoredBy: false, GIT_CONFIG_KEY_0: 'core.fsmonitor', SSH_KEY: 'k' },
      {},
    );
    const text = render(changes).join('\n');
    expect(text).toContain('+ includeCoAuthoredBy: false');
    expect(text).toContain('+ GIT_CONFIG_KEY_0: "core.fsmonitor"');
    expect(text).toContain('+ SSH_KEY: <redacted>');
  });

  test('redactValue walks nested objects and arrays', () => {
    expect(redactValue({ a: [{ password: 'p' }], b: { SECRET_X: 's', ok: 1 } })).toEqual({
      a: [{ password: '<redacted>' }],
      b: { SECRET_X: '<redacted>', ok: 1 },
    });
  });
});

describe('helpers', () => {
  test('formatValue handles bigint and dates', () => {
    expect(formatValue({ n: 60n, d: new Date('2026-01-02T03:04:05Z'), s: 'x' })).toBe(
      '{"n": 60, "d": 2026-01-02T03:04:05.000Z, "s": "x"}',
    );
  });

  test('valuesEqual ignores key order but not array order', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual(1n, 1)).toBe(false);
  });

  test('JSON_CODEC reads JSONC and writes 2-space JSON', () => {
    expect(JSON_CODEC.parse('// c\n{ "a": [1,], }')).toEqual({ a: [1] });
    expect(JSON_CODEC.stringify({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
    expect(() => JSON_CODEC.parse('[1]')).toThrow('expected a top-level object');
  });
});
