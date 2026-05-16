/**
 * Tests for lib/node/pi/research-paths.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  labRoot,
  paths,
  quarantineDir,
  runRoot,
  SLUG_MAX_LENGTH,
  slugify,
} from '../../../../lib/node/pi/research-paths.ts';

describe('slugify', () => {
  test('kebab-cases a plain question', () => {
    expect(slugify('What is the best way to bake bread?')).toBe('what-is-the-best-way-to-bake-bread');
  });

  test('lowercases and collapses runs of non-alphanumerics', () => {
    expect(slugify('Hello_World!!  foo   BAR')).toBe('hello-world-foo-bar');
  });

  test('strips diacritics via NFKD', () => {
    // "café crème brûlée" → "cafe-creme-brulee"
    expect(slugify('café crème brûlée')).toBe('cafe-creme-brulee');
  });

  test('trims leading and trailing dashes', () => {
    expect(slugify('   --???--leading and trailing--???--   ')).toBe('leading-and-trailing');
  });

  test('truncates to the default max length without trailing dash', () => {
    const long = 'a'.repeat(80);
    const out = slugify(long);

    expect(out.length).toBe(SLUG_MAX_LENGTH);
    expect(out).toBe('a'.repeat(SLUG_MAX_LENGTH));
  });

  test('does not leave a trailing dash after truncation', () => {
    // Crafted so the byte at SLUG_MAX_LENGTH falls mid-separator.
    // "word-" repeated: at length 40, the next char would be '-'.
    const input = 'word-'.repeat(20);
    const out = slugify(input);

    expect(out.endsWith('-')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  test('respects a caller-supplied maxLength', () => {
    expect(slugify('hello world foo bar baz', { maxLength: 11 })).toBe('hello-world');
  });

  test('falls back to a deterministic timestamp slug on empty input', () => {
    const frozen = new Date(Date.UTC(2025, 0, 2, 3, 4, 5)); // 2025-01-02 03:04:05 UTC

    expect(slugify('', { fallbackTimestamp: frozen })).toBe('r-20250102-030405');
  });

  test('falls back to a timestamp slug when input has no usable chars', () => {
    const frozen = new Date(Date.UTC(2030, 10, 11, 12, 13, 14));

    expect(slugify('///---   ???', { fallbackTimestamp: frozen })).toBe('r-20301111-121314');
  });
});

describe('runRoot / labRoot', () => {
  test('runRoot returns <cwd>/research/<slug>', () => {
    expect(runRoot('/home/u/proj', 'my-slug')).toBe('/home/u/proj/research/my-slug');
  });

  test('labRoot returns <cwd>/research/lab/<slug>', () => {
    expect(labRoot('/home/u/proj', 'my-slug')).toBe('/home/u/proj/research/lab/my-slug');
  });

  test('relative cwd yields a relative root', () => {
    expect(runRoot('.', 's')).toBe('research/s');
  });
});

describe('paths()', () => {
  test('derives all well-known run paths from a root', () => {
    const p = paths('/r');

    expect(p.plan).toBe('/r/plan.json');
    expect(p.journal).toBe('/r/journal.md');
    expect(p.report).toBe('/r/report.md');
    expect(p.sources).toBe('/r/sources');
    expect(p.findings).toBe('/r/findings');
    expect(p.snapshots).toBe('/r/snapshots');
    expect(p.fanout).toBe('/r/fanout.json');
    expect(p.experiments).toBe('/r/experiments');
  });

  test('quarantineRootFor delegates to quarantineDir', () => {
    const p = paths('/r');

    expect(p.quarantineRootFor('/r/findings')).toBe(quarantineDir('/r/findings'));
    expect(p.quarantineRootFor('/r/findings')).toBe('/r/findings/_quarantined');
  });

  test('provenanceFor appends .provenance.json', () => {
    const p = paths('/r');

    expect(p.provenanceFor('/r/findings/f-1.md')).toBe('/r/findings/f-1.md.provenance.json');
    expect(p.provenanceFor('/r/plan.json')).toBe('/r/plan.json.provenance.json');
  });
});

describe('quarantineDir', () => {
  test('returns <parent>/_quarantined', () => {
    expect(quarantineDir('/r/findings')).toBe('/r/findings/_quarantined');
  });

  test('composes on nested parents without flattening', () => {
    expect(quarantineDir('/r/experiments/exp-1')).toBe('/r/experiments/exp-1/_quarantined');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure-mode / pathological inputs.
// ──────────────────────────────────────────────────────────────────────

describe('slugify - failure modes', () => {
  test('handles a single char input', () => {
    expect(slugify('a')).toBe('a');
  });

  test('handles input composed entirely of separators', () => {
    const frozen = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

    expect(slugify('   ---   ', { fallbackTimestamp: frozen })).toBe('r-20000101-000000');
  });

  test('emoji and non-ASCII CJK collapse to the timestamp fallback', () => {
    // NFKD on CJK / emoji does not yield ASCII letters; they get
    // stripped by the `[^a-z0-9]` replace. Fallback must kick in.
    const frozen = new Date(Date.UTC(1999, 11, 31, 23, 59, 58));

    expect(slugify('你好 🌍', { fallbackTimestamp: frozen })).toBe('r-19991231-235958');
  });

  test('extremely long pathological inputs still produce bounded output', () => {
    const huge = 'x'.repeat(10_000);
    const out = slugify(huge);

    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });
});
