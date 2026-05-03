/**
 * Tests for lib/node/pi/research-citations.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  type CitationSource,
  extractPlaceholders,
  renumber,
  validatePlaceholders,
} from '../../../../lib/node/pi/research-citations.ts';

const src = (id: string, title = `title-${id}`, url = `https://example.com/${id}`): CitationSource => ({
  id,
  title,
  url,
});

function indexOf(...sources: CitationSource[]): Map<string, CitationSource> {
  return new Map(sources.map((s) => [s.id, s]));
}

describe('extractPlaceholders', () => {
  test('finds all occurrences in document order', () => {
    const draft = 'one {{SRC:a}} two {{SRC:b}} three {{SRC:a}} four';

    expect(extractPlaceholders(draft)).toEqual([
      { match: '{{SRC:a}}', id: 'a' },
      { match: '{{SRC:b}}', id: 'b' },
      { match: '{{SRC:a}}', id: 'a' },
    ]);
  });

  test('returns [] on a draft with no placeholders', () => {
    expect(extractPlaceholders('no sources mentioned here.')).toEqual([]);
  });

  test('ignores malformed placeholder prefixes', () => {
    const draft = '{{src:lowercase}} {{SRC :with-space}} {{NOTSRC:abc}}';

    expect(extractPlaceholders(draft)).toEqual([]);
  });
});

describe('validatePlaceholders', () => {
  test('ok=true when every id is known', () => {
    const draft = 'a={{SRC:a}}, b={{SRC:b}}';
    const r = validatePlaceholders(draft, new Set(['a', 'b']));

    expect(r).toEqual({ ok: true, unknown: [] });
  });

  test('ok=true for an empty draft', () => {
    expect(validatePlaceholders('plain text', new Set())).toEqual({ ok: true, unknown: [] });
  });

  test('unknown ids are reported in first-appearance order with no dups', () => {
    const draft = '{{SRC:x}} {{SRC:known}} {{SRC:y}} {{SRC:x}} {{SRC:z}} {{SRC:y}}';
    const r = validatePlaceholders(draft, new Set(['known']));

    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['x', 'y', 'z']);
  });

  test('case-sensitive id matching', () => {
    const r = validatePlaceholders('{{SRC:ABC}}', new Set(['abc']));

    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['ABC']);
  });
});

describe('renumber', () => {
  test('renders first-use-ordered footnote markers', () => {
    const draft = 'First {{SRC:a}}, second {{SRC:b}}, third {{SRC:c}}.';
    const r = renumber(draft, indexOf(src('a'), src('b'), src('c')));

    expect(r.report).toBe('First [^1], second [^2], third [^3].');
  });

  test('stable numbering across repeated references', () => {
    const draft = 'p {{SRC:a}} q {{SRC:b}} r {{SRC:a}} s {{SRC:a}} t {{SRC:b}}';
    const r = renumber(draft, indexOf(src('a'), src('b')));

    expect(r.report).toBe('p [^1] q [^2] r [^1] s [^1] t [^2]');
  });

  test('footnotes block is assembled in first-use order', () => {
    const draft = 'z {{SRC:b}} y {{SRC:a}} x {{SRC:c}} w {{SRC:a}}';
    const r = renumber(draft, indexOf(src('a'), src('b'), src('c')));

    expect(r.footnotes).toBe(
      '[^1]: title-b — https://example.com/b\n' +
        '[^2]: title-a — https://example.com/a\n' +
        '[^3]: title-c — https://example.com/c\n',
    );
  });

  test('footnote titles collapse embedded whitespace', () => {
    const draft = '{{SRC:a}}';
    const r = renumber(draft, indexOf({ id: 'a', title: 'a  \n  noisy\ttitle', url: 'https://x' }));

    expect(r.footnotes).toBe('[^1]: a noisy title — https://x\n');
  });

  test('empty title falls back to (untitled)', () => {
    const draft = '{{SRC:a}}';
    const r = renumber(draft, indexOf({ id: 'a', title: '', url: 'https://x' }));

    expect(r.footnotes).toBe('[^1]: (untitled) — https://x\n');
  });

  test('no known placeholders → empty footnotes block', () => {
    const draft = 'just text';
    const r = renumber(draft, indexOf(src('a')));

    expect(r.report).toBe('just text');
    expect(r.footnotes).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes.
// ──────────────────────────────────────────────────────────────────────

describe('renumber — failure modes', () => {
  test('unknown placeholders are left untouched (loud, not silent)', () => {
    const draft = 'good {{SRC:a}} bad {{SRC:ghost}} good {{SRC:a}}';
    const r = renumber(draft, indexOf(src('a')));

    expect(r.report).toBe('good [^1] bad {{SRC:ghost}} good [^1]');
    expect(r.footnotes).toBe('[^1]: title-a — https://example.com/a\n');
  });

  test('mixed known+unknown: validator separately reports the unknown', () => {
    const draft = 'a {{SRC:a}} b {{SRC:ghost}}';

    // renumber preserves the unknown marker…
    const r = renumber(draft, indexOf(src('a')));

    expect(r.report).toContain('{{SRC:ghost}}');

    // …and validatePlaceholders flags it afterward.
    const v = validatePlaceholders(r.report, new Set(['a']));

    expect(v.ok).toBe(false);
    expect(v.unknown).toEqual(['ghost']);
  });

  test('surrounding punctuation is preserved', () => {
    const draft = 'See ({{SRC:a}}), and later: {{SRC:a}}.';
    const r = renumber(draft, indexOf(src('a')));

    expect(r.report).toBe('See ([^1]), and later: [^1].');
  });

  test('idempotent: renumbering the already-rewritten report with no new placeholders is a no-op', () => {
    const draft = '{{SRC:a}} x {{SRC:b}}';
    const first = renumber(draft, indexOf(src('a'), src('b')));
    const second = renumber(first.report, indexOf(src('a'), src('b')));

    expect(second.report).toBe(first.report);
    // Second pass has no placeholders to count, so footnotes are empty.
    expect(second.footnotes).toBe('');
  });

  test('empty draft returns empty result with no footnotes', () => {
    const r = renumber('', indexOf(src('a')));

    expect(r.report).toBe('');
    expect(r.footnotes).toBe('');
  });

  test('an id of length zero is not a valid placeholder match', () => {
    // `{{SRC:}}` — no id — does not match our regex (requires at
    // least one char before `}`). Defense-in-depth against
    // dangling-colon model outputs.
    const draft = '{{SRC:}} and {{SRC:x}}';

    expect(extractPlaceholders(draft)).toEqual([{ match: '{{SRC:x}}', id: 'x' }]);
  });
});
