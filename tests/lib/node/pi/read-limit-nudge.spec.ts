/**
 * Tests for lib/node/pi/read-limit-nudge.ts — pure module, no pi.
 */

import { describe, expect, test } from 'vitest';

import {
  classifyRead,
  DEFAULT_MIN_BYTES,
  DEFAULT_MIN_LINES,
  formatNudge,
  NUDGE_MARKER,
  type NudgeProbe,
  type TruncationLike,
} from '../../../../lib/node/pi/read-limit-nudge.ts';
import { assertKind } from './helpers.ts';

function probe(trunc: TruncationLike, opts: { offset?: number; limit?: number; path?: string } = {}): NudgeProbe {
  return {
    displayPath: opts.path ?? 'src/foo.ts',
    offset: opts.offset,
    limit: opts.limit,
    truncation: trunc,
  };
}

// ──────────────────────────────────────────────────────────────────────
// skip paths
// ──────────────────────────────────────────────────────────────────────

describe('classifyRead — skip paths', () => {
  test('had-offset: skip when offset is present', () => {
    const out = classifyRead(probe({ totalLines: 10_000 }, { offset: 100 }));

    assertKind(out, 'skip');

    expect(out.reason).toBe('had-offset');
  });

  test('had-limit: skip when limit is present', () => {
    const out = classifyRead(probe({ totalLines: 10_000 }, { limit: 50 }));

    assertKind(out, 'skip');

    expect(out.reason).toBe('had-limit');
  });

  test('already-truncated: skip when pi reported truncation', () => {
    const out = classifyRead(probe({ totalLines: 10_000, truncated: true }));

    assertKind(out, 'skip');

    expect(out.reason).toBe('already-truncated');
  });

  test('unknown-size: skip when both totalLines and totalBytes are missing', () => {
    const out = classifyRead(probe({}));

    assertKind(out, 'skip');

    expect(out.reason).toBe('unknown-size');
  });

  test('small-file: skip when under both thresholds', () => {
    const out = classifyRead(probe({ totalLines: 10, totalBytes: 100 }));

    assertKind(out, 'skip');

    expect(out.reason).toBe('small-file');
  });

  test('binary-content: skip when the read returned non-text parts (e.g. image)', () => {
    const out = classifyRead({
      ...probe({ totalLines: 10_000, totalBytes: 10 * 1024 * 1024 }),
      isBinary: true,
    });

    assertKind(out, 'skip');

    expect(out.reason).toBe('binary-content');
  });

  test('binary-content: isBinary wins over had-offset / had-limit precedence', () => {
    // Order of precedence in classifyRead: had-offset, had-limit,
    // binary-content, then the rest. We don't want a binary read with
    // offset to slip through to the truncation branch via synthesized
    // byte thresholds, but we also don't want binary to mask an
    // explicit offset/limit (those are already skip paths). Spot-check
    // the ordering here so future reorderings surface in CI.
    const withOffset = classifyRead({
      ...probe({ totalLines: 10_000 }, { offset: 1 }),
      isBinary: true,
    });

    assertKind(withOffset, 'skip');

    expect(withOffset.reason).toBe('had-offset');
  });
});

// ──────────────────────────────────────────────────────────────────────
// nudge paths
// ──────────────────────────────────────────────────────────────────────

describe('classifyRead — nudge paths', () => {
  test('nudge by lines at the default threshold', () => {
    const out = classifyRead(probe({ totalLines: DEFAULT_MIN_LINES }));

    assertKind(out, 'nudge');

    expect(out.reason).toBe('lines');
    expect(out.nudge).toContain(NUDGE_MARKER);
    expect(out.nudge).toContain(`${DEFAULT_MIN_LINES} lines`);
    expect(out.nudge).toContain('rg -n');
  });

  test('nudge by bytes when lines are below threshold but bytes exceed it', () => {
    const out = classifyRead(probe({ totalLines: 10, totalBytes: DEFAULT_MIN_BYTES }));

    assertKind(out, 'nudge');

    expect(out.reason).toBe('bytes');
  });

  test('custom thresholds override defaults', () => {
    const out = classifyRead(probe({ totalLines: 50 }), { minLines: 40, minBytes: 1_000_000 });

    assertKind(out, 'nudge');

    expect(out.reason).toBe('lines');
  });

  test('nudge mentions the display path', () => {
    const out = classifyRead(probe({ totalLines: 1000 }, { path: 'pkg/bar.py' }));

    assertKind(out, 'nudge');

    expect(out.nudge).toContain('pkg/bar.py');
  });

  test('lines trigger beats bytes trigger (order-preserved)', () => {
    const out = classifyRead(probe({ totalLines: 10_000, totalBytes: 1 }));

    assertKind(out, 'nudge');

    expect(out.reason).toBe('lines');
  });

  test('custom marker flows through', () => {
    const out = classifyRead(probe({ totalLines: 10_000 }), { marker: '!! T' });

    assertKind(out, 'nudge');

    expect(out.nudge.startsWith('!! T ')).toBe(true);
    expect(out.nudge).not.toContain(NUDGE_MARKER);
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatNudge byte formatting
// ──────────────────────────────────────────────────────────────────────

describe('formatNudge byte rendering', () => {
  test('renders bytes in KB for mid-range values', () => {
    const p = probe({ totalBytes: 50 * 1024 });
    const text = formatNudge(p, 'bytes');

    expect(text).toContain('50.0KB');
  });

  test('renders bytes in MB for larger values', () => {
    const p = probe({ totalBytes: 5 * 1024 * 1024 });
    const text = formatNudge(p, 'bytes');

    expect(text).toContain('5.00MB');
  });

  test('falls back to "large" when bytes unknown', () => {
    const p = probe({});
    const text = formatNudge(p, 'bytes');

    expect(text).toContain('large');
  });
});
