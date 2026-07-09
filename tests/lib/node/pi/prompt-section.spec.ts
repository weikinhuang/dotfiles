/**
 * Tests for lib/node/pi/prompt-section.ts - shared system-prompt section
 * append helpers. Pure module.
 */

import { describe, expect, test } from 'vitest';

import { appendSectionByHeading, appendSectionOnce } from '../../../../lib/node/pi/prompt-section.ts';

describe('appendSectionByHeading', () => {
  const heading = '## Section';
  const section = `${heading}\n\nbody text`;

  test('appends with a blank-line separator, trimming base trailing space', () => {
    expect(appendSectionByHeading('base prompt\n\n', section, heading)).toBe(`base prompt\n\n${section}`);
  });

  test('idempotent when the heading is already present', () => {
    const already = `base\n\n${section}`;
    expect(appendSectionByHeading(already, section, heading)).toBe(already);
  });

  test('returns the section verbatim for an empty-ish base', () => {
    expect(appendSectionByHeading('', section, heading)).toBe(section);
    expect(appendSectionByHeading('   \n', section, heading)).toBe(section);
  });

  test('does not trim the section itself', () => {
    const padded = `${heading}\n\nbody\n`;
    expect(appendSectionByHeading('base', padded, heading)).toBe(`base\n\n${padded}`);
  });
});

describe('appendSectionOnce', () => {
  test('appends the trimmed section with a blank-line separator', () => {
    expect(appendSectionOnce('base\n', '  add me  ')).toBe('base\n\nadd me');
  });

  test('empty-ish section returns base unchanged', () => {
    expect(appendSectionOnce('base', '   ')).toBe('base');
  });

  test('empty-ish base returns the trimmed section', () => {
    expect(appendSectionOnce('  \n', '  add  ')).toBe('add');
  });

  test('idempotent when base already ends with the trimmed section', () => {
    const base = 'base\n\nadd me';
    expect(appendSectionOnce(base, 'add me')).toBe(base);
    expect(appendSectionOnce(`${base}\n\n`, 'add me')).toBe(`${base}\n\n`);
  });
});
