/**
 * Regression: tolerant fact parsing in lib/node/pi/roleplay/capture.ts.
 */
import { expect, test } from 'vitest';

import { parseFactCandidates } from '../../../../../../lib/node/pi/roleplay/capture.ts';

test('capture-review: a bracketed aside before the JSON array does not discard the facts', () => {
  const raw = 'Facts from the span [2 found]:\n[{"name":"User is allergic to shellfish","description":"severe"}]';
  expect(parseFactCandidates(raw)).toEqual([{ name: 'User is allergic to shellfish', description: 'severe' }]);
});

test('capture-review: fenced, bare, and string-embedded brackets still parse; no array yields none', () => {
  const fact = { name: 'Base is Rhodes Island', description: 'the [landship]' };
  expect(parseFactCandidates(`\`\`\`json\n${JSON.stringify([fact])}\n\`\`\``)).toEqual([fact]);
  expect(parseFactCandidates(`[note] [also] ${JSON.stringify([fact])} trailing [x]`)).toEqual([fact]);
  expect(parseFactCandidates('no facts [here] at all')).toEqual([]);
});
