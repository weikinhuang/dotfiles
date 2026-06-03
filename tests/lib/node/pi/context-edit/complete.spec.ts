/**
 * Tests for lib/node/pi/context-edit/complete.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  completeCandidatesOrVerbs,
  type CompletionCandidate,
} from '../../../../../lib/node/pi/context-edit/complete.ts';
import type { SubverbSpec } from '../../../../../lib/node/pi/commands/complete.ts';

const candidates: CompletionCandidate[] = [
  { id: 'img1', description: 'image (24.7KB): 1 image from read' },
  { id: 'msg1', description: 'user msg (1L 65B): Read Example.jpg ...' },
  { id: 'tool2', description: 'result bash (412L 38KB): + npm test ...' },
];

const verbs: SubverbSpec = {
  list: { description: 'Show active trims' },
  restore: { description: 'Undo a trim by #id', args: () => [{ label: '1' }, { label: '5' }] },
  clear: { description: 'Undo all trims' },
};

describe('completeCandidatesOrVerbs - level 1', () => {
  test('offers candidate handles AND verbs, candidates first', () => {
    const items = completeCandidatesOrVerbs('', candidates, verbs);
    expect(items?.map((i) => i.value)).toEqual(['img1', 'msg1', 'tool2', 'list', 'restore', 'clear']);
  });

  test('candidate descriptions carry size + snippet for picking', () => {
    const items = completeCandidatesOrVerbs('', candidates, verbs);
    const img = items?.find((i) => i.value === 'img1');
    expect(img?.label).toBe('img1');
    expect(img?.description).toContain('24.7KB');
  });

  test('prefix filters across both candidates and verbs', () => {
    expect(completeCandidatesOrVerbs('img', candidates, verbs)?.map((i) => i.value)).toEqual(['img1']);
    expect(completeCandidatesOrVerbs('li', candidates, verbs)?.map((i) => i.value)).toEqual(['list']);
    expect(completeCandidatesOrVerbs('to', candidates, verbs)?.map((i) => i.value)).toEqual(['tool2']);
  });

  test('returns null when nothing matches', () => {
    expect(completeCandidatesOrVerbs('zzz', candidates, verbs)).toBeNull();
  });

  test('works with no candidates (only verbs surface)', () => {
    expect(completeCandidatesOrVerbs('', [], verbs)?.map((i) => i.value)).toEqual(['list', 'restore', 'clear']);
  });
});

describe('completeCandidatesOrVerbs - level 2 delegates to subverbs', () => {
  test('restore <id> value carries the verb prefix', () => {
    const items = completeCandidatesOrVerbs('restore ', candidates, verbs);
    expect(items?.map((i) => i.value)).toEqual(['restore 1', 'restore 5']);
  });

  test('restore filters by the partial id', () => {
    expect(completeCandidatesOrVerbs('restore 5', candidates, verbs)?.map((i) => i.value)).toEqual(['restore 5']);
  });

  test('a candidate handle in slot 1 does not trigger level-2 (it is terminal)', () => {
    // "img1 " has a trailing space, so parts.length > 1 -> treated as verb arg;
    // img1 is not a verb, so subverb completion yields null.
    expect(completeCandidatesOrVerbs('img1 ', candidates, verbs)).toBeNull();
  });
});
