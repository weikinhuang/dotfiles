/**
 * Tests for lib/node/pi/bg-bash-ring.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
import { RingBuffer } from '../../../../lib/node/pi/bg-bash-ring.ts';

// ──────────────────────────────────────────────────────────────────────
// Basic append + read
// ──────────────────────────────────────────────────────────────────────

test('read: empty buffer returns an empty slice with cursor 0', () => {
  const r = new RingBuffer();
  const out = r.read();

  expect(out.content).toBe('');
  expect(out.cursor).toBe(0);
  expect(out.totalBytes).toBe(0);
  expect(out.droppedBytes).toBe(0);
  expect(out.droppedBefore).toBe(false);
});

test('append + read: returns all bytes when under the cap', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('hello ');
  r.append('world');
  const out = r.read();

  expect(out.content).toBe('hello world');
  expect(out.cursor).toBe(11);
  expect(out.totalBytes).toBe(11);
  expect(out.droppedBytes).toBe(0);
});

test('read with sinceCursor returns only newer data', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('aaa');
  const a = r.read();
  r.append('bbb');
  const b = r.read({ sinceCursor: a.cursor });

  expect(b.content).toBe('bbb');
  expect(b.cursor).toBe(6);
  expect(b.droppedBefore).toBe(false);
});

test('read with sinceCursor at end-of-stream returns empty but updates cursor', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('aaa');
  const a = r.read();
  const b = r.read({ sinceCursor: a.cursor });

  expect(b.content).toBe('');
  expect(b.cursor).toBe(3);
});

test('read maxBytes caps to a byte-length tail', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('abcdefghij'); // 10 bytes
  const out = r.read({ maxBytes: 4 });

  expect(out.content).toBe('ghij');
  expect(out.cursor).toBe(10);
});

// ──────────────────────────────────────────────────────────────────────
// Eviction
// ──────────────────────────────────────────────────────────────────────

test('eviction: drops oldest chunks when total exceeds cap', () => {
  const r = new RingBuffer({ maxBytes: 10 });
  r.append('aaaaa'); // 5 bytes
  r.append('bbbbb'); // 5 bytes, total 10 — fits
  r.append('ccccc'); // 5 bytes, total 15 — evicts 'aaaaa'

  const out = r.read();

  expect(out.content).toBe('bbbbbccccc');
  expect(out.droppedBytes).toBe(5);
  expect(out.totalBytes).toBe(15);
});

test('eviction: partial eviction trims the front of the oldest chunk', () => {
  const r = new RingBuffer({ maxBytes: 6 });
  r.append('abcdef'); // fills
  r.append('xy'); // overflow by 2 — front of 'abcdef' chopped by 2
  const out = r.read();

  expect(out.content).toBe('cdefxy');
  expect(out.droppedBytes).toBe(2);
});

test('eviction: single oversized append keeps the tail and reports the drop', () => {
  const r = new RingBuffer({ maxBytes: 4 });
  r.append('0123456789'); // 10 bytes, cap is 4
  const out = r.read();

  expect(out.content).toBe('6789');
  expect(out.droppedBytes).toBe(6);
  expect(out.totalBytes).toBe(10);
});

test('eviction: maxBytes 0 retains nothing but still tracks totals', () => {
  const r = new RingBuffer({ maxBytes: 0 });
  r.append('stuff');
  const out = r.read();

  expect(out.content).toBe('');
  expect(out.totalBytes).toBe(5);
  expect(out.droppedBytes).toBe(5);
});

// ──────────────────────────────────────────────────────────────────────
// Cursor invalidation
// ──────────────────────────────────────────────────────────────────────

test('droppedBefore: true when cursor points before the retained window', () => {
  const r = new RingBuffer({ maxBytes: 4 });
  r.append('abcd');
  const a = r.read();
  r.append('efgh'); // evicts 'abcd'
  const b = r.read({ sinceCursor: a.cursor - 4 }); // pre-retained

  expect(b.droppedBefore).toBe(true);
  expect(b.content).toBe('efgh');
  expect(b.cursor).toBe(8);
});

test('droppedBefore: false when cursor is still inside the retained window', () => {
  const r = new RingBuffer({ maxBytes: 100 });
  r.append('abcd');
  const a = r.read();
  r.append('ef');
  const b = r.read({ sinceCursor: a.cursor });

  expect(b.droppedBefore).toBe(false);
  expect(b.content).toBe('ef');
});

// ──────────────────────────────────────────────────────────────────────
// tailLines
// ──────────────────────────────────────────────────────────────────────

test('tailLines(n): returns the last n \\n-separated lines', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('one\ntwo\nthree\nfour\nfive\n');

  expect(r.tailLines(2).content).toBe('four\nfive\n');
  expect(r.tailLines(1).content).toBe('five\n');
});

test('tailLines(n): unterminated last line is included', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('one\ntwo\nthree');

  expect(r.tailLines(1).content).toBe('three');
  expect(r.tailLines(2).content).toBe('two\nthree');
});

test('tailLines(n): fewer lines than requested returns the whole buffer', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('solo line\n');

  expect(r.tailLines(10).content).toBe('solo line\n');
});

test('tailLines(0): returns empty', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('anything\n');

  expect(r.tailLines(0).content).toBe('');
});

// ──────────────────────────────────────────────────────────────────────
// grep
// ──────────────────────────────────────────────────────────────────────

test('grep: returns lines matching the regex', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('info: starting\nerror: oh no\ninfo: done\nerror: fatal\n');
  const hits = r.grep(/^error:/);

  expect(hits).toEqual(['error: oh no\n', 'error: fatal\n']);
});

test('grep: maxMatches clamps to the last N matches', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('a\na\na\nb\na\n');

  expect(r.grep(/a/, { maxMatches: 2 })).toEqual(['a\n', 'a\n']);
});

// ──────────────────────────────────────────────────────────────────────
// UTF-8 safety
// ──────────────────────────────────────────────────────────────────────

test('eviction: trims on codepoint boundaries (no broken multi-byte)', () => {
  // Each "é" is 2 UTF-8 bytes.
  const r = new RingBuffer({ maxBytes: 3 });
  r.append('éé'); // 4 bytes — overflow by 1; we'd like to return a valid-UTF-8 suffix.
  const out = r.read();

  // Either we return just the second 'é' (2 bytes, valid) or empty — we
  // must NEVER return a mid-codepoint byte. Assert the string decodes
  // without a replacement char.
  expect(out.content.includes('\uFFFD')).toBe(false);
  // Byte accounting is exact regardless.
  expect(out.totalBytes).toBe(4);
  expect(out.droppedBytes + new TextEncoder().encode(out.content).length).toBe(4);
});

test('single oversized append with multi-byte chars keeps a valid-UTF-8 tail', () => {
  const r = new RingBuffer({ maxBytes: 5 });
  // 10 bytes of 2-byte codepoints.
  r.append('éééééé'); // 12 bytes
  const out = r.read();

  expect(out.content.includes('\uFFFD')).toBe(false);
  expect(out.totalBytes).toBe(12);
});

// ──────────────────────────────────────────────────────────────────────
// Previews + accessors
// ──────────────────────────────────────────────────────────────────────

test('tailPreview: returns the last <= n bytes', () => {
  const r = new RingBuffer({ maxBytes: 1024 });
  r.append('0123456789');

  expect(r.tailPreview(4)).toBe('6789');
  expect(r.tailPreview(100)).toBe('0123456789');
  expect(r.tailPreview(0)).toBe('');
});

test('byte-length accessors', () => {
  const r = new RingBuffer({ maxBytes: 5 });
  r.append('0123456789');

  expect(r.byteLengthTotal).toBe(10);
  expect(r.byteLengthDropped).toBe(5);
  expect(r.byteLengthRetained).toBe(5);
});
