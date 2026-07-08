/**
 * Tests for lib/node/pi/iteration-loop/nudge.ts.
 *
 * Pure string builders - the specs pin the exact follow-up message
 * text (marker prefix, task interpolation, and the fixed guidance
 * sentences) the extension delivers.
 */

import { describe, expect, test } from 'vitest';

import { buildClaimNudge, buildStrictEditNudge } from '../../../../../lib/node/pi/iteration-loop/nudge.ts';

describe('buildStrictEditNudge', () => {
  test('renders the marker, artifact, edit count, and task', () => {
    expect(
      buildStrictEditNudge({
        marker: '⚠ [pi-iteration-loop-strict-edit]',
        artifact: 'out.svg',
        edits: 3,
        task: 'default',
      }),
    ).toBe(
      "⚠ [pi-iteration-loop-strict-edit] You've edited the declared artifact " +
        '`out.svg` ' +
        '3 time(s) without running the check. ' +
        'Call `check run task=default` now to verify the changes ' +
        'against the rubric before claiming anything about the artifact. ' +
        "If you're mid-edit and the next edit is atomic, make it, then run the check.",
    );
  });

  test('threads a non-default task name through both interpolation points', () => {
    const msg = buildStrictEditNudge({ marker: 'M', artifact: 'a', edits: 1, task: 'logo' });
    expect(msg).toContain('check run task=logo');
  });
});

describe('buildClaimNudge', () => {
  test('renders the marker, matched source, and task', () => {
    expect(
      buildClaimNudge({ marker: '⚠ [pi-iteration-loop-claim]', matchedSource: 'looks right', task: 'default' }),
    ).toBe(
      '⚠ [pi-iteration-loop-claim] You claimed the artifact is correct (matched: `looks right`), ' +
        "but you haven't run `check run task=default` this turn. " +
        'Either run the check to confirm, or retract the claim. The iteration-loop contract is: ' +
        'no "looks right / done / matches spec" without a passing verdict in the same turn.',
    );
  });
});
