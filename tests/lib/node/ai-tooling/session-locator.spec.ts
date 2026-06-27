import { describe, expect, test } from 'vitest';

import { type Candidate, pickSession } from '../../../../lib/node/ai-tooling/session-locator.ts';

function cand(id: string, mtimeMs: number): Candidate {
  return { id, filePath: `/sessions/${id}.jsonl`, mtimeMs };
}

describe('pickSession', () => {
  test('returns not-found for an empty candidate set', () => {
    expect(pickSession([], 'abc')).toEqual({ ok: false, error: 'not-found' });
    expect(pickSession([])).toEqual({ ok: false, error: 'not-found' });
  });

  test('with no id, picks the newest candidate by mtime', () => {
    const r = pickSession([cand('a', 100), cand('b', 300), cand('c', 200)]);
    expect(r).toEqual({ ok: true, filePath: '/sessions/b.jsonl' });
  });

  test('resolves a unique id prefix', () => {
    const r = pickSession([cand('019f0109-aaa', 1), cand('019f01b7-bbb', 2)], '019f0109');
    expect(r).toEqual({ ok: true, filePath: '/sessions/019f0109-aaa.jsonl' });
  });

  test('reports ambiguity when a prefix matches multiple ids', () => {
    const r = pickSession([cand('019f01-aaa', 1), cand('019f01-bbb', 2)], '019f01');
    expect(r).toEqual({ ok: false, error: 'ambiguous', matches: ['019f01-aaa', '019f01-bbb'] });
  });

  test('an exact id wins over multiple prefix matches', () => {
    const r = pickSession([cand('abc', 1), cand('abcdef', 2)], 'abc');
    expect(r).toEqual({ ok: true, filePath: '/sessions/abc.jsonl' });
  });

  test('matches on a substring of the file path (codex uuid-in-filename)', () => {
    const r = pickSession([{ id: 'rollout-x', filePath: '/s/rollout-2026-019cf83f.jsonl', mtimeMs: 1 }], '019cf83f');
    expect(r).toEqual({ ok: true, filePath: '/s/rollout-2026-019cf83f.jsonl' });
  });

  test('returns not-found when no candidate matches the id', () => {
    expect(pickSession([cand('a', 1), cand('b', 2)], 'zzz')).toEqual({ ok: false, error: 'not-found' });
  });
});
