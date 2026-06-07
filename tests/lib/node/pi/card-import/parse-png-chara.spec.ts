/**
 * Tests for lib/node/pi/card-import/parse-png-chara.ts.
 *
 * Pure module - no pi runtime needed. PNG fixtures are constructed in
 * memory (signature + chunks) so no binary file is committed.
 */

import { expect, test } from 'vitest';

import { extractCardJson, isPng, parsePngTextChunks } from '../../../../../lib/node/pi/card-import/parse-png-chara.ts';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): number[] {
  const len = data.length;
  const out = [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
  for (const ch of type) out.push(ch.charCodeAt(0));
  out.push(...data);
  out.push(0, 0, 0, 0); // CRC (ignored by the parser)
  return out;
}

function textChunk(keyword: string, text: string): number[] {
  const data: number[] = [];
  for (const ch of keyword) data.push(ch.charCodeAt(0));
  data.push(0);
  for (const ch of text) data.push(ch.charCodeAt(0));
  return chunk('tEXt', new Uint8Array(data));
}

function makePng(...chunks: number[][]): Uint8Array {
  const bytes = [...SIG];
  for (const c of chunks) bytes.push(...c);
  bytes.push(...chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(bytes);
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

test('isPng recognizes the signature', () => {
  expect(isPng(makePng())).toBe(true);
  expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
  expect(isPng(new Uint8Array(0))).toBe(false);
});

test('parsePngTextChunks extracts keyword -> text', () => {
  const png = makePng(textChunk('Title', 'Hello'), textChunk('Author', 'Me'));
  const chunks = parsePngTextChunks(png);
  expect(chunks.get('Title')).toBe('Hello');
  expect(chunks.get('Author')).toBe('Me');
});

test('extractCardJson decodes the chara chunk', () => {
  const json = JSON.stringify({ name: 'Exusiai' });
  const png = makePng(textChunk('chara', b64(json)));
  expect(extractCardJson(png)).toBe(json);
});

test('extractCardJson prefers ccv3 over chara', () => {
  const v2 = JSON.stringify({ spec: 'chara_card_v2' });
  const v3 = JSON.stringify({ spec: 'chara_card_v3' });
  const png = makePng(textChunk('chara', b64(v2)), textChunk('ccv3', b64(v3)));
  expect(extractCardJson(png)).toBe(v3);
});

test('extractCardJson returns null for a PNG with no card chunk', () => {
  expect(extractCardJson(makePng(textChunk('Comment', 'just a picture')))).toBeNull();
});

test('extractCardJson returns null for non-PNG bytes', () => {
  expect(extractCardJson(new Uint8Array([1, 2, 3, 4]))).toBeNull();
});

test('parsePngTextChunks stops cleanly on a truncated chunk', () => {
  // Valid first chunk, then a length header that overruns the buffer.
  const png = [...SIG, ...textChunk('chara', b64('{}')), 0x00, 0x00, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74];
  const chunks = parsePngTextChunks(new Uint8Array(png));
  expect(chunks.get('chara')).toBe(b64('{}'));
});
