/**
 * Regression: card import / export edge cases (lib/node/pi/card-import/**).
 */
import { expect, test } from 'vitest';

import {
  cardToRecords,
  normalizeCard,
  type NormalizedCard,
} from '../../../../../../lib/node/pi/card-import/card-to-records.ts';
import { extractCardJson } from '../../../../../../lib/node/pi/card-import/parse-png-chara.ts';
import { planCardExport } from '../../../../../../lib/node/pi/card-import/records-to-card.ts';
import { emptyLoreMeta } from '../../../../../../lib/node/pi/roleplay/store.ts';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  const out = [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
  for (const ch of type) out.push(ch.charCodeAt(0));
  out.push(...data, 0, 0, 0, 0);
  return out;
}
function textChunk(keyword: string, text: string): number[] {
  return chunk('tEXt', [...Buffer.from(keyword, 'latin1'), 0, ...Buffer.from(text, 'latin1')]);
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

test('card-import-review: an empty ccv3 chunk falls back to a valid chara chunk', () => {
  const v2 = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Mira' } });
  const png = new Uint8Array([...SIG, ...textChunk('ccv3', ''), ...textChunk('chara', b64(v2)), ...chunk('IEND', [])]);
  expect(extractCardJson(png)).toBe(v2);
});

test('card-import-review: an unparseable ccv3 chunk falls back to a valid chara chunk', () => {
  const v2 = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Mira' } });
  const png = new Uint8Array([
    ...SIG,
    ...textChunk('ccv3', b64('not json')),
    ...textChunk('chara', b64(v2)),
    ...chunk('IEND', []),
  ]);
  expect(extractCardJson(png)).toBe(v2);
});

test('card-import-review: export warns (or round-trips) a lore description the importer will not re-derive', () => {
  // An imported lore entry with no comment gets description `triggers: a, b` and name = keys[0].
  const lore = { ...emptyLoreMeta(), triggers: ['reef', 'tide'] };
  const rec = { name: 'reef', description: 'triggers: reef, tide', body: 'The reef.', lore };
  const { card, warnings } = planCardExport({ name: 'Mira', description: 'A diver', body: 'Sheet.' }, [rec]);
  const reimported = cardToRecords(normalizeCard(JSON.parse(JSON.stringify(card))) as NormalizedCard);
  const back = reimported.records.find((r) => r.kind === 'lore');
  const survived = back?.description === rec.description;
  const warned = warnings.some((w) => w.includes('description'));
  // Either the description survives the round trip, or the exporter must say it is dropped.
  expect(survived || warned).toBe(true);
});

test('card-import-review: ccv3 still wins when valid, and an unparseable sole chunk is surfaced for a parse error', () => {
  const v3 = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Three' } });
  const v2 = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Two' } });
  const both = new Uint8Array([
    ...SIG,
    ...textChunk('chara', b64(v2)),
    ...textChunk('ccv3', b64(v3)),
    ...chunk('IEND', []),
  ]);
  expect(extractCardJson(both)).toBe(v3);
  const bad = new Uint8Array([...SIG, ...textChunk('chara', b64('garbage')), ...chunk('IEND', [])]);
  expect(extractCardJson(bad)).toBe('garbage');
});
