import { describe, expect, it } from 'vitest';

import {
  buildFactExtractionTask,
  MAX_FACT_DESC_CHARS,
  MAX_FACT_NAME_CHARS,
  MAX_FACTS_PER_ROLL,
  parseFactCandidates,
} from '../../../../../lib/node/pi/roleplay/capture.ts';

describe('buildFactExtractionTask', () => {
  it('embeds the span and asks for a bounded self-contained JSON array', () => {
    const task = buildFactExtractionTask('user: I am allergic to shellfish');
    expect(task).toContain('allergic to shellfish');
    expect(task).toContain('JSON array');
    expect(task).toContain(String(MAX_FACTS_PER_ROLL));
    expect(task).toContain('self-contained');
  });
});

describe('parseFactCandidates', () => {
  it('returns [] for empty / null / empty-array sentinels', () => {
    expect(parseFactCandidates('')).toEqual([]);
    expect(parseFactCandidates('null')).toEqual([]);
    expect(parseFactCandidates('[]')).toEqual([]);
    expect(parseFactCandidates('no json here')).toEqual([]);
  });

  it('parses a bare JSON array', () => {
    const out = parseFactCandidates('[{"name":"User allergic to shellfish","description":"stated at dinner"}]');
    expect(out).toEqual([{ name: 'User allergic to shellfish', description: 'stated at dinner' }]);
  });

  it('parses a fenced ```json block embedded in prose', () => {
    const raw =
      'Here are the facts:\n```json\n[{"name":"Lives in Rhodes Island","description":"her home base"}]\n```\ndone';
    const out = parseFactCandidates(raw);
    expect(out).toEqual([{ name: 'Lives in Rhodes Island', description: 'her home base' }]);
  });

  it('falls back to name when description is missing', () => {
    const out = parseFactCandidates('[{"name":"Meets Kal at noon"}]');
    expect(out).toEqual([{ name: 'Meets Kal at noon', description: 'Meets Kal at noon' }]);
  });

  it('drops entries with no usable name and de-dups by lowercased name', () => {
    const out = parseFactCandidates(
      '[{"description":"no name"},{"name":"  ","description":"blank"},{"name":"Fact A","description":"x"},{"name":"fact a","description":"dup"}]',
    );
    expect(out).toEqual([{ name: 'Fact A', description: 'x' }]);
  });

  it('clamps over-long name and description', () => {
    const longName = 'N'.repeat(200);
    const longDesc = 'D'.repeat(500);
    const out = parseFactCandidates(`[{"name":"${longName}","description":"${longDesc}"}]`);
    expect(out[0].name.length).toBeLessThanOrEqual(MAX_FACT_NAME_CHARS);
    expect(out[0].description.length).toBeLessThanOrEqual(MAX_FACT_DESC_CHARS);
  });

  it('caps the number of facts', () => {
    const many = Array.from({ length: 20 }, (_, i) => `{"name":"Fact ${i}","description":"d${i}"}`).join(',');
    const out = parseFactCandidates(`[${many}]`);
    expect(out.length).toBe(MAX_FACTS_PER_ROLL);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseFactCandidates('[{name: unquoted}]')).toEqual([]);
    expect(parseFactCandidates('[{"name":"x",')).toEqual([]);
  });
});
