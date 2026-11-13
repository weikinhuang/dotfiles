import { describe, expect, test } from 'vitest';

import {
  renderJsonStringArray,
  replaceMarkedRegion,
  setJsonStringArrays,
} from '../../../../lib/node/agents-config/file-regions.ts';

describe('replaceMarkedRegion', () => {
  const text = ['# head', '# BEGIN GENERATED x: notes', 'old 1', 'old 2', '# END GENERATED x', '# tail', ''].join('\n');

  test('replaces only the lines between the markers', () => {
    expect(replaceMarkedRegion(text, 'x', ['new'])).toBe(
      ['# head', '# BEGIN GENERATED x: notes', 'new', '# END GENERATED x', '# tail', ''].join('\n'),
    );
  });

  test('an empty body leaves the markers adjacent', () => {
    expect(replaceMarkedRegion(text, 'x', [])).toBe('# head\n# BEGIN GENERATED x: notes\n# END GENERATED x\n# tail\n');
  });

  test('a marker name does not match a longer name', () => {
    expect(() => replaceMarkedRegion(text.replaceAll('GENERATED x', 'GENERATED x-y'), 'x', [])).toThrow(
      '<text>: expected exactly one "BEGIN GENERATED x" line, found 0',
    );
  });

  test('rejects duplicate or reversed markers', () => {
    expect(() => replaceMarkedRegion(`${text}# BEGIN GENERATED x\n`, 'x', [], 'f')).toThrow(
      'f: expected exactly one "BEGIN GENERATED x" line, found 2',
    );
    expect(() => replaceMarkedRegion('END GENERATED x\nBEGIN GENERATED x\n', 'x', [], 'f')).toThrow(
      'f: "END GENERATED x" must come after "BEGIN GENERATED x"',
    );
  });
});

describe('renderJsonStringArray', () => {
  test('inline when it fits, counting the trailing comma', () => {
    expect(renderJsonStringArray('k', ['a', 'b'], '  ', true)).toBe('["a", "b"]');
  });

  test('one item per line when too wide', () => {
    const long = 'x'.repeat(60);
    expect(renderJsonStringArray('k', [long, long], '    ', false)).toBe(`[\n      "${long}",\n      "${long}"\n    ]`);
  });

  test('the trailing comma can tip a borderline array onto several lines', () => {
    // `  "k": ["…"]` is exactly 120 columns.
    const value = 'x'.repeat(120 - '  "k": [""]'.length);
    expect(renderJsonStringArray('k', [value], '  ', false)).toBe(`["${value}"]`);
    expect(renderJsonStringArray('k', [value], '  ', true)).toBe(`[\n    "${value}"\n  ]`);
  });
});

describe('setJsonStringArrays', () => {
  const doc = `{
  "a": 1,
  "permissions": {
    "mode": "auto",
    "allow": ["old"],
    "deny": ["Read(.env)"]
  },
  "z": { "allow": ["untouched"] }
}
`;

  test('replaces an existing array and inserts a missing one after the anchor', () => {
    const out = setJsonStringArrays(doc, ['permissions'], { allow: ['x', 'y'], ask: ['q'] }, 'allow');
    expect(out).toBe(`{
  "a": 1,
  "permissions": {
    "mode": "auto",
    "allow": ["x", "y"],
    "ask": ["q"],
    "deny": ["Read(.env)"]
  },
  "z": { "allow": ["untouched"] }
}
`);
  });

  test('replaces an existing ask in place and leaves other keys alone', () => {
    const withAsk = setJsonStringArrays(doc, ['permissions'], { ask: ['q'] }, 'allow');
    const out = setJsonStringArrays(withAsk, ['permissions'], { allow: ['n'], ask: ['r', 's'] }, 'allow');
    expect(JSON.parse(out)).toEqual({
      a: 1,
      permissions: { mode: 'auto', allow: ['n'], ask: ['r', 's'], deny: ['Read(.env)'] },
      z: { allow: ['untouched'] },
    });
  });

  test('inserting after the last member adds no trailing comma', () => {
    const out = setJsonStringArrays('{\n  "p": {\n    "allow": []\n  }\n}\n', ['p'], { ask: ['a'] }, 'allow');
    expect(out).toBe('{\n  "p": {\n    "allow": [],\n    "ask": ["a"]\n  }\n}\n');
  });

  test('does not insert an empty missing array', () => {
    expect(setJsonStringArrays(doc, ['permissions'], { ask: [] }, 'allow')).toBe(doc);
  });

  test('handles brackets and escaped quotes inside strings', () => {
    const tricky = '{\n  "p": {\n    "allow": ["a]\\"}", "b"],\n    "x": "}"\n  }\n}\n';
    const out = setJsonStringArrays(tricky, ['p'], { allow: ['c'] }, 'allow');
    expect(JSON.parse(out)).toEqual({ p: { allow: ['c'], x: '}' } });
  });

  test('errors on a missing path or anchor', () => {
    expect(() => setJsonStringArrays(doc, ['nope'], { allow: [] }, 'allow')).toThrow('missing object "nope"');
    expect(() => setJsonStringArrays(doc, ['permissions'], { ask: [] }, 'nope')).toThrow('missing "permissions.nope"');
  });
});
