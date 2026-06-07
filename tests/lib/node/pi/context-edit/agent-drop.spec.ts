/**
 * Tests for lib/node/pi/context-edit/agent-drop.ts.
 *
 * Pure module - no pi runtime needed. Covers the recency-ordinal
 * resolver, the tail-guard, the drop-decision entries + title builders,
 * and the non-interactive env-default parse.
 */

import { describe, expect, test } from 'vitest';

import {
  buildDropEntries,
  buildDropTitle,
  byRecency,
  DEFAULT_TAIL_GUARD,
  nonInteractiveDropDefault,
  resolveRecencyTargets,
  toTitleItem,
} from '../../../../../lib/node/pi/context-edit/agent-drop.ts';
import { type Candidate } from '../../../../../lib/node/pi/context-edit/enumerate.ts';

// Build N image candidates in document order (seq 0..N-1, oldest first).
function imageCands(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `img${i + 1}`,
    seq: i,
    kind: 'image' as const,
    target: { by: 'toolCallId' as const, toolCallId: `c${i}` },
    toolCallId: `c${i}`,
    bytes: 1000 + i,
    lines: 0,
    snippet: `image ${i}`,
  }));
}

describe('byRecency', () => {
  test('ranks newest (highest seq) as ordinal 1, regardless of input order', () => {
    const cands = imageCands(3);
    // Shuffle so input order != seq order.
    const ranked = byRecency([cands[1], cands[0], cands[2]]);
    expect(ranked.map((r) => r.candidate.toolCallId)).toEqual(['c2', 'c1', 'c0']);
    expect(ranked.map((r) => r.ordinal)).toEqual([1, 2, 3]);
  });

  test('falls back to input order when seq is absent', () => {
    const a = { ...imageCands(1)[0], seq: undefined as unknown as number, toolCallId: 'a' };
    const b = { ...imageCands(1)[0], seq: undefined as unknown as number, toolCallId: 'b' };
    const ranked = byRecency([a, b]);
    expect(ranked.map((r) => r.ordinal)).toEqual([1, 2]);
  });
});

describe('resolveRecencyTargets - pointed (drop)', () => {
  test('drops the addressed ordinal past the tail-guard', () => {
    const r = resolveRecencyTargets(imageCands(4), { drop: [2] }, 1);
    expect(r.selected.map((s) => s.ordinal)).toEqual([2]);
    expect(r.guarded).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(4);
  });

  test('an ordinal inside the tail-guard is refused, not dropped', () => {
    const r = resolveRecencyTargets(imageCands(4), { drop: [1] }, 1);
    expect(r.selected).toEqual([]);
    expect(r.guarded.map((s) => s.ordinal)).toEqual([1]);
  });

  test('out-of-range ordinals land in missing', () => {
    const r = resolveRecencyTargets(imageCands(2), { drop: [5, 0] }, 1);
    expect(r.selected).toEqual([]);
    expect(r.missing).toEqual([5, 0]);
  });
});

describe('resolveRecencyTargets - batch (keepRecent)', () => {
  test('drops everything beyond the most recent N', () => {
    const r = resolveRecencyTargets(imageCands(5), { keepRecent: 2 }, 1);
    expect(r.selected.map((s) => s.ordinal)).toEqual([3, 4, 5]);
  });

  test('clamps keepRecent up to the tail-guard so the protected tail is never reached', () => {
    const r = resolveRecencyTargets(imageCands(4), { keepRecent: 0 }, 2);
    // guard=2 -> keep at least 2; drop ordinals 3,4 only.
    expect(r.selected.map((s) => s.ordinal)).toEqual([3, 4]);
    expect(r.guarded).toEqual([]);
  });

  test('keepRecent >= total selects nothing', () => {
    const r = resolveRecencyTargets(imageCands(3), { keepRecent: 3 }, 1);
    expect(r.selected).toEqual([]);
  });
});

describe('resolveRecencyTargets - union + dedup', () => {
  test('drop + keepRecent union without double-counting an ordinal', () => {
    const r = resolveRecencyTargets(imageCands(5), { drop: [2], keepRecent: 3 }, 1);
    // keepRecent:3 -> 4,5; drop:[2] -> 2. Union sorted: 2,4,5.
    expect(r.selected.map((s) => s.ordinal)).toEqual([2, 4, 5]);
  });

  test('the default tail-guard is 1', () => {
    expect(DEFAULT_TAIL_GUARD).toBe(1);
    const r = resolveRecencyTargets(imageCands(2), { drop: [1, 2] });
    expect(r.guarded.map((s) => s.ordinal)).toEqual([1]);
    expect(r.selected.map((s) => s.ordinal)).toEqual([2]);
  });
});

describe('buildDropEntries', () => {
  test('offers the six options with the tool name in the session option', () => {
    const entries = buildDropEntries('drop_image');
    expect(entries.map((e) => e.decision.kind)).toEqual([
      'allow-once',
      'allow-session',
      'edit-selection',
      'deny',
      'deny-feedback',
      'never-session',
    ]);
    expect(entries.find((e) => e.decision.kind === 'allow-session')?.label).toContain('drop_image');
  });
});

describe('buildDropTitle', () => {
  const items = [toTitleItem({ candidate: imageCands(1)[0], ordinal: 2 }, 'a red fox')];

  test('echoes resolved items + reason + the reversible / no-deletion framing', () => {
    const title = buildDropTitle({ verb: 'drop', noun: 'image(s)', items, reason: 'done iterating' });
    expect(title).toContain('REVERSIBLE');
    expect(title).toContain('#2');
    expect(title).toContain('a red fox');
    expect(title).toContain('done iterating');
    expect(title).toContain('Nothing is deleted from the transcript or disk');
  });

  test('surfaces tail-guarded ordinals and missing ordinals', () => {
    const title = buildDropTitle({
      verb: 'drop',
      noun: 'image(s)',
      items,
      guarded: [toTitleItem({ candidate: imageCands(1)[0], ordinal: 1 })],
      missing: [9],
    });
    expect(title).toContain('Protected by the tail-guard');
    expect(title).toContain('No candidate at: #9');
  });
});

describe('nonInteractiveDropDefault', () => {
  test('only the literal "allow" opts in; everything else is deny', () => {
    expect(nonInteractiveDropDefault('allow')).toBe('allow');
    expect(nonInteractiveDropDefault('ALLOW')).toBe('allow');
    expect(nonInteractiveDropDefault('deny')).toBe('deny');
    expect(nonInteractiveDropDefault(undefined)).toBe('deny');
    expect(nonInteractiveDropDefault('yes')).toBe('deny');
  });
});
