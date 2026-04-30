/**
 * Tests for lib/node/pi/output-condense.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
import { condense, parseToolList, splitLines } from '../../../../lib/node/pi/output-condense.ts';

// ──────────────────────────────────────────────────────────────────────
// splitLines
// ──────────────────────────────────────────────────────────────────────

test('splitLines: empty string → empty array', () => {
  expect(splitLines('')).toEqual([]);
});

test('splitLines: single line without newline', () => {
  expect(splitLines('hello')).toEqual(['hello']);
});

test('splitLines: preserves trailing empty line after final \\n', () => {
  expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
});

test('splitLines: multi-line no trailing newline', () => {
  expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
});

// ──────────────────────────────────────────────────────────────────────
// condense
// ──────────────────────────────────────────────────────────────────────

test('condense: empty input → empty result, not truncated', () => {
  const r = condense('');
  expect(r.truncated).toBe(false);
  expect(r.text).toBe('');
  expect(r.originalBytes).toBe(0);
  expect(r.originalLines).toBe(0);
  expect(r.outputBytes).toBe(0);
  expect(r.outputLines).toBe(0);
});

test('condense: short input under both caps passes through', () => {
  const text = 'line one\nline two\nline three';
  const r = condense(text, { maxBytes: 1024, maxLines: 100 });
  expect(r.truncated).toBe(false);
  expect(r.text).toBe(text);
  expect(r.outputLines).toBe(3);
});

test('condense: exceeding only the line cap triggers truncation', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const r = condense(lines.join('\n'), { maxLines: 200, maxBytes: 10 * 1024 * 1024, headLines: 20, tailLines: 20 });
  expect(r.truncated).toBe(true);
  expect(r.outputLines).toBeLessThan(lines.length);
  expect(r.text).toMatch(/line 1$/m);
  expect(r.text).toMatch(/line 500$/m);
  expect(r.text).toMatch(/omitted/);
});

test('condense: exceeding only the byte cap triggers truncation', () => {
  // Ten very long lines, each ~2KB → 20KB total, over 12KB cap.
  const bigLine = 'x'.repeat(2000);
  const text = Array.from({ length: 10 }, () => bigLine).join('\n');
  const r = condense(text, { maxBytes: 12 * 1024, maxLines: 10_000, headLines: 2, tailLines: 2 });
  expect(r.truncated).toBe(true);
  expect(r.outputBytes).toBeLessThanOrEqual(12 * 1024 + 512);
  expect(r.text).toMatch(/omitted/);
});

test('condense: head + tail markers preserve first and last lines', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
  const r = condense(lines.join('\n'), { maxLines: 20, headLines: 5, tailLines: 5, maxBytes: 10_000 });
  expect(r.truncated).toBe(true);
  const out = splitLines(r.text);
  expect(out[0]).toBe('L1');
  expect(out[out.length - 1]).toBe('L100');
  // First 5 head lines must be L1..L5.
  expect(out.slice(0, 5)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
  // Last 5 tail lines must be L96..L100.
  expect(out.slice(out.length - 5)).toEqual(['L96', 'L97', 'L98', 'L99', 'L100']);
  // There should be a single omission marker between them.
  const markerIdx = out.findIndex((l) => l.includes('omitted'));
  expect(markerIdx).toBe(5);
});

test('condense: marker reports an accurate omitted count', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
  const r = condense(lines.join('\n'), { maxLines: 20, headLines: 10, tailLines: 10, maxBytes: 10_000 });
  expect(r.text).toMatch(/\[80 line\(s\)/);
});

test('condense: head/tail overlap case (headLines + tailLines ≥ total) returns whole text if it fits', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
  // maxLines 5 forces truncation consideration; headLines + tailLines = 20 covers all.
  const r = condense(lines.join('\n'), {
    maxLines: 5,
    headLines: 15,
    tailLines: 15,
    maxBytes: 10_000,
  });
  // Output should contain ALL lines (no omission marker), and NOT be
  // marked truncated because the whole thing fits under maxBytes.
  expect(r.truncated).toBe(false);
  expect(r.outputLines).toBe(10);
  expect(r.text).not.toMatch(/omitted/);
});

test('condense: clamps tiny maxBytes to the 512-byte floor', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1} padded padded padded`);
  // Setting maxBytes to 1 must not crash — lib enforces a floor.
  const r = condense(lines.join('\n'), { maxBytes: 1, maxLines: 5, headLines: 2, tailLines: 2 });
  expect(r.truncated).toBe(true);
  // The floor ensures the result fits within the enforced 512-byte target.
  // Give ~200 bytes of slack for the marker and boundaries.
  expect(r.outputBytes).toBeLessThanOrEqual(512 + 512);
});

test('condense: clamps tiny maxLines to the 20-line floor', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `L${i + 1}`);
  // maxLines < 20 should be treated as 20. With headLines/tailLines each = 80 (default)
  // and floor-clamped maxLines = 20, we still get head+marker+tail output.
  const r = condense(lines.join('\n'), { maxLines: 1, maxBytes: 10 * 1024 });
  expect(r.truncated).toBe(true);
});

test('condense: reports accurate original byte count (UTF-8 aware)', () => {
  // Emoji is multi-byte in UTF-8 — originalBytes must reflect encoded length.
  const text = '✓ ok\n✓ ok\n✓ ok';
  const r = condense(text, { maxBytes: 10_000, maxLines: 100 });
  expect(r.truncated).toBe(false);
  // '✓' is 3 bytes in UTF-8; '✓ ok' = 6 bytes; 3 lines + 2 newlines = 20 bytes.
  expect(r.originalBytes).toBe(20);
  expect(r.originalLines).toBe(3);
});

test('condense: output byte count reflects the condensed text', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const r = condense(lines.join('\n'), {
    maxLines: 50,
    maxBytes: 10_000,
    headLines: 10,
    tailLines: 10,
  });
  expect(r.truncated).toBe(true);
  // outputBytes should match the actual length of the condensed text.
  expect(r.outputBytes).toBe(new TextEncoder().encode(r.text).length);
});

test('condense: always keeps at least the first line when head takes effect', () => {
  // One huge first line (>halfBytes) + many short tail lines.
  const huge = 'A'.repeat(50_000);
  const tailLines = Array.from({ length: 50 }, (_, i) => `t${i + 1}`);
  const text = [huge, ...tailLines].join('\n');
  const r = condense(text, { maxBytes: 12 * 1024, maxLines: 100, headLines: 3, tailLines: 10 });
  expect(r.truncated).toBe(true);
  const outLines = splitLines(r.text);
  // Even though the first line is bigger than the per-half budget, the
  // head window must keep it (else we'd lose "what command produced this").
  expect(outLines[0].startsWith('A')).toBe(true);
});

test('condense: default options still trigger on 200KB input', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `log entry ${i} ${'x'.repeat(40)}`).join('\n');
  const r = condense(text);
  expect(r.truncated).toBe(true);
  expect(r.outputBytes).toBeLessThan(r.originalBytes);
  expect(r.outputLines).toBeLessThan(r.originalLines);
});

// ──────────────────────────────────────────────────────────────────────
// parseToolList
// ──────────────────────────────────────────────────────────────────────

test('parseToolList: empty / undefined → fallback', () => {
  expect([...parseToolList(undefined, ['bash'])]).toEqual(['bash']);
  expect([...parseToolList('', ['bash'])]).toEqual(['bash']);
  expect([...parseToolList('   ', ['bash'])]).toEqual(['bash']);
});

test('parseToolList: splits on commas and trims', () => {
  const s = parseToolList('bash, rg , grep', ['bash']);
  expect([...s].sort()).toEqual(['bash', 'grep', 'rg']);
});

test('parseToolList: lowercases entries', () => {
  const s = parseToolList('Bash,RG', ['bash']);
  expect([...s].sort()).toEqual(['bash', 'rg']);
});

test('parseToolList: fallback is also lowercased', () => {
  const s = parseToolList(undefined, ['Bash', 'RG']);
  expect([...s].sort()).toEqual(['bash', 'rg']);
});

test('parseToolList: filters out empty entries from trailing commas', () => {
  const s = parseToolList('bash,,rg,', ['bash']);
  expect([...s].sort()).toEqual(['bash', 'rg']);
});
