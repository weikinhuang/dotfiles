/**
 * Tests for lib/node/pi/apply-patch/parse.ts. Pure module — no fs.
 */

import { describe, expect, test } from 'vitest';

import { parsePatch } from '../../../../../lib/node/pi/apply-patch/parse.ts';
import { assertHas } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Happy paths
// ──────────────────────────────────────────────────────────────────────

describe('parsePatch: happy paths', () => {
  test('Update File with one hunk', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@',
      ' context',
      '-removed',
      '+added',
      ' tail',
      '*** End Patch',
    ].join('\n');

    expect(parsePatch(input)).toEqual({
      patch: {
        ops: [
          {
            type: 'update',
            path: 'src/foo.ts',
            hunks: [
              {
                lines: [
                  { kind: ' ', text: 'context' },
                  { kind: '-', text: 'removed' },
                  { kind: '+', text: 'added' },
                  { kind: ' ', text: 'tail' },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  test('Update File with multiple hunks', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' a',
      '-b',
      '+B',
      '@@',
      ' c',
      '-d',
      '+D',
      '*** End Patch',
    ].join('\n');

    const out = parsePatch(input);
    assertHas(out, 'patch');
    expect(out.patch.ops).toHaveLength(1);
    const op = out.patch.ops[0];
    if (op?.type !== 'update') throw new Error('expected update op');
    expect(op.hunks).toHaveLength(2);
  });

  test('Add File', () => {
    const input = ['*** Begin Patch', '*** Add File: new/file.ts', '+line one', '+line two', '*** End Patch'].join(
      '\n',
    );

    expect(parsePatch(input)).toEqual({
      patch: {
        ops: [{ type: 'add', path: 'new/file.ts', content: 'line one\nline two' }],
      },
    });
  });

  test('Delete File', () => {
    const input = ['*** Begin Patch', '*** Delete File: old/file.ts', '*** End Patch'].join('\n');

    expect(parsePatch(input)).toEqual({
      patch: {
        ops: [{ type: 'delete', path: 'old/file.ts' }],
      },
    });
  });

  test('Move File with no hunks', () => {
    const input = ['*** Begin Patch', '*** Move File: a.ts -> b.ts', '*** End Patch'].join('\n');

    expect(parsePatch(input)).toEqual({
      patch: {
        ops: [{ type: 'move', from: 'a.ts', to: 'b.ts', hunks: [] }],
      },
    });
  });

  test('Move File with hunks against the OLD path', () => {
    const input = [
      '*** Begin Patch',
      '*** Move File: old/a.ts -> new/b.ts',
      '@@',
      ' keep',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const out = parsePatch(input);
    assertHas(out, 'patch');
    const op = out.patch.ops[0];
    if (op?.type !== 'move') throw new Error('expected move op');
    expect(op.from).toBe('old/a.ts');
    expect(op.to).toBe('new/b.ts');
    expect(op.hunks).toHaveLength(1);
  });

  test('multi-op patch (golden fixture: realistic multi-file change)', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/feature.ts',
      '@@',
      ' export function feature() {',
      '-  return "old";',
      '+  return "new";',
      ' }',
      '*** Add File: src/feature.spec.ts',
      "+import { test, expect } from 'vitest';",
      "+import { feature } from './feature.ts';",
      '+',
      "+test('feature returns new', () => {",
      "+  expect(feature()).toBe('new');",
      '+});',
      '*** Delete File: src/legacy.ts',
      '*** Move File: src/util.ts -> src/utils/index.ts',
      '@@',
      ' export function pad(s: string) {',
      '-  return " " + s;',
      '+  return "  " + s;',
      ' }',
      '*** End Patch',
    ].join('\n');

    const out = parsePatch(input);
    assertHas(out, 'patch');
    expect(out.patch.ops.map((o) => o.type)).toEqual(['update', 'add', 'delete', 'move']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Trailing-whitespace tolerance
// ──────────────────────────────────────────────────────────────────────

describe('parsePatch: trailing-whitespace tolerance', () => {
  test('trailing spaces on Begin/End/op headers are tolerated', () => {
    const input = ['*** Begin Patch   ', '*** Update File: a.ts\t', '@@  ', ' a', '-b', '+B', '*** End Patch  '].join(
      '\n',
    );

    const out = parsePatch(input);
    assertHas(out, 'patch');
    expect(out.patch.ops).toHaveLength(1);
  });

  test('CRLF line endings are accepted', () => {
    const input = ['*** Begin Patch', '*** Delete File: x.ts', '*** End Patch'].join('\r\n');

    const out = parsePatch(input);
    assertHas(out, 'patch');
    expect(out.patch.ops).toHaveLength(1);
  });

  test('leading whitespace on the Begin marker is NOT tolerated (strict marker form)', () => {
    const out = parsePatch('   *** Begin Patch\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.line).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Malformed inputs
// ──────────────────────────────────────────────────────────────────────

describe('parsePatch: malformed inputs', () => {
  test('missing Begin marker', () => {
    const out = parsePatch('*** Update File: a.ts\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.line).toBe(1);
    expect(out.error.message).toContain('Begin Patch');
  });

  test('missing End marker', () => {
    const out = parsePatch('*** Begin Patch\n*** Delete File: a.ts\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('End Patch');
  });

  test('Update File without a path', () => {
    const out = parsePatch('*** Begin Patch\n*** Update File: \n@@\n a\n-b\n+B\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('requires a path');
  });

  test('hunk header @@ appearing before any op', () => {
    const out = parsePatch('*** Begin Patch\n@@\n a\n-b\n+B\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('@@');
    expect(out.error.message).toContain('before');
  });

  test('Update File with no @@ hunk', () => {
    const out = parsePatch('*** Begin Patch\n*** Update File: a.ts\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('at least one');
  });

  test('hunk line with bad prefix', () => {
    const out = parsePatch('*** Begin Patch\n*** Update File: a.ts\n@@\n%bad\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('hunk line');
  });

  test('Add File body with a non-+ line', () => {
    const out = parsePatch('*** Begin Patch\n*** Add File: new.ts\n+ok\n-bad\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('"+"');
  });

  test('Add File with empty body is rejected', () => {
    const out = parsePatch('*** Begin Patch\n*** Add File: new.ts\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('at least one');
  });

  test('Move File without "->" separator', () => {
    const out = parsePatch('*** Begin Patch\n*** Move File: a.ts b.ts\n*** End Patch\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('->');
  });

  test('unknown line between ops', () => {
    const out = parsePatch(
      [
        '*** Begin Patch',
        '*** Delete File: a.ts',
        'random unrelated line',
        '*** Delete File: b.ts',
        '*** End Patch',
      ].join('\n'),
    );
    assertHas(out, 'error');
    expect(out.error.message).toContain('unexpected');
  });

  test('content after End Patch is an error', () => {
    const out = parsePatch('*** Begin Patch\n*** Delete File: a.ts\n*** End Patch\noops\n');
    assertHas(out, 'error');
    expect(out.error.message).toContain('after');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

describe('parsePatch: edge cases', () => {
  test('blank line inside a hunk becomes a blank context line', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' first',
      '',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const out = parsePatch(input);
    assertHas(out, 'patch');
    const op = out.patch.ops[0];
    if (op?.type !== 'update') throw new Error('expected update op');
    expect(op.hunks[0]?.lines).toEqual([
      { kind: ' ', text: 'first' },
      { kind: ' ', text: '' },
      { kind: '-', text: 'old' },
      { kind: '+', text: 'new' },
    ]);
  });

  test('blank line between ops is tolerated', () => {
    const out = parsePatch(
      ['*** Begin Patch', '*** Delete File: a.ts', '', '*** Delete File: b.ts', '*** End Patch'].join('\n'),
    );
    assertHas(out, 'patch');
    expect(out.patch.ops).toHaveLength(2);
  });
});
