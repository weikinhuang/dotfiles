/**
 * Tests for lib/node/pi/iteration-loop-reducer.ts.
 */

import { describe, expect, test } from 'vitest';
import {
  actAccept,
  actClose,
  actRecordEdit,
  actRun,
  ITERATION_CUSTOM_TYPE,
  ITERATION_TOOL_NAME,
  reduceBranch,
  stateFromEntry,
  type BranchEntry,
} from '../../../../lib/node/pi/iteration-loop-reducer.ts';
import {
  emptyIterationState,
  type IterationState,
  type Verdict,
} from '../../../../lib/node/pi/iteration-loop-schema.ts';
import { assertErr, assertOk } from './helpers.ts';

const startedAt = '2026-05-01T00:00:00Z';

const seedState = (over: Partial<IterationState> = {}): IterationState => ({
  ...emptyIterationState('default', startedAt),
  ...over,
});

const approved: Verdict = { approved: true, score: 1, issues: [] };
const notApproved = (score = 0.5): Verdict => ({
  approved: false,
  score,
  issues: [{ severity: 'major', description: 'x' }],
});

describe('actAccept', () => {
  test('seeds fresh state at acceptedAt timestamp', () => {
    const r = actAccept(null, { task: 'default', acceptedAt: startedAt });
    assertOk(r);

    expect(r.state.task).toBe('default');
    expect(r.state.iteration).toBe(0);
    expect(r.state.startedAt).toBe(startedAt);
    expect(r.state.history).toEqual([]);
  });

  test('requires task + acceptedAt', () => {
    const a = actAccept(null, { task: '', acceptedAt: startedAt });
    assertErr(a);

    expect(a.error).toMatch(/task/);

    const b = actAccept(null, { task: 'x', acceptedAt: '' });
    assertErr(b);

    expect(b.error).toMatch(/acceptedAt/);
  });
});

describe('actRecordEdit', () => {
  test('bumps counter from 0 → 1 → 2', () => {
    let s = seedState();
    const r1 = actRecordEdit(s);
    assertOk(r1);

    expect(r1.state.editsSinceLastCheck).toBe(1);

    s = r1.state;
    const r2 = actRecordEdit(s);
    assertOk(r2);

    expect(r2.state.editsSinceLastCheck).toBe(2);
  });

  test('refuses when no active loop', () => {
    const r = actRecordEdit(null);
    assertErr(r);

    expect(r.error).toMatch(/no active loop/);
  });

  test('refuses when loop stopped', () => {
    const r = actRecordEdit(seedState({ stopReason: 'passed' }));
    assertErr(r);

    expect(r.error).toMatch(/terminated/);
  });
});

describe('actRun', () => {
  test('first run: increments iteration, resets edits, records verdict', () => {
    const s = seedState({ editsSinceLastCheck: 3 });
    const r = actRun(s, {
      verdict: notApproved(0.4),
      costDeltaUsd: 0.02,
      turnNumber: 7,
      snapshot: { path: '/snap/iter-001.svg', hash: 'h1' },
      stopReason: null,
      ranAt: '2026-05-01T00:01:00Z',
    });
    assertOk(r);

    expect(r.state.iteration).toBe(1);
    expect(r.state.editsSinceLastCheck).toBe(0);
    expect(r.state.lastCheckTurn).toBe(7);
    expect(r.state.lastVerdict?.score).toBe(0.4);
    expect(r.state.costUsd).toBe(0.02);
    expect(r.state.history).toHaveLength(1);
    expect(r.state.bestSoFar?.iteration).toBe(1);
    expect(r.state.stopReason).toBeNull();
  });

  test('approved verdict wins bestSoFar even over higher-scored non-approved', () => {
    let s = seedState();
    const rNot = actRun(s, {
      verdict: notApproved(0.9),
      costDeltaUsd: 0,
      turnNumber: 1,
      snapshot: { path: '/s1', hash: 'h1' },
      stopReason: null,
      ranAt: '2026-05-01T00:01:00Z',
    });
    assertOk(rNot);
    s = rNot.state;
    const rApp = actRun(s, {
      verdict: { ...approved, score: 0.6 }, // approved lower-scored
      costDeltaUsd: 0,
      turnNumber: 2,
      snapshot: { path: '/s2', hash: 'h2' },
      stopReason: 'passed',
      ranAt: '2026-05-01T00:02:00Z',
    });
    assertOk(rApp);

    expect(rApp.state.bestSoFar?.snapshotPath).toBe('/s2');
    expect(rApp.state.stopReason).toBe('passed');
  });

  test('no snapshot ⇒ bestSoFar preserved from prior', () => {
    const s = seedState({
      bestSoFar: { iteration: 1, score: 0.8, approved: false, snapshotPath: '/s1', artifactHash: 'h1' },
    });
    const r = actRun(s, {
      verdict: notApproved(0.3),
      costDeltaUsd: 0,
      turnNumber: 1,
      snapshot: null,
      stopReason: null,
      ranAt: '2026-05-01T00:01:00Z',
    });
    assertOk(r);

    expect(r.state.bestSoFar?.snapshotPath).toBe('/s1');
  });

  test('refuses when stopped', () => {
    const s = seedState({ stopReason: 'passed' });
    const r = actRun(s, {
      verdict: approved,
      costDeltaUsd: 0,
      turnNumber: 1,
      snapshot: null,
      stopReason: null,
      ranAt: '2026-05-01T00:01:00Z',
    });
    assertErr(r);

    expect(r.error).toMatch(/terminated/);
  });
});

describe('actClose', () => {
  test('sets stopReason; idempotent on re-close', () => {
    const s = seedState();
    const r = actClose(s, { reason: 'user-closed' });
    assertOk(r);

    expect(r.state.stopReason).toBe('user-closed');

    const r2 = actClose(r.state, { reason: 'passed' });
    assertOk(r2);

    expect(r2.state.stopReason).toBe('user-closed'); // idempotent — keeps original
  });

  test('rejects invalid reason', () => {
    const r = actClose(seedState(), { reason: 'bogus' as unknown as 'passed' });
    assertErr(r);

    expect(r.error).toMatch(/invalid close reason/);
  });
});

describe('stateFromEntry / reduceBranch', () => {
  test('recognizes tool-result entry', () => {
    const state = seedState({ iteration: 3 });
    const entry: BranchEntry = {
      type: 'message',
      message: { role: 'toolResult', toolName: ITERATION_TOOL_NAME, details: state },
    };

    expect(stateFromEntry(entry)?.iteration).toBe(3);
  });

  test('recognizes custom-type mirror entry', () => {
    const state = seedState({ iteration: 7 });
    const entry: BranchEntry = { type: 'custom', customType: ITERATION_CUSTOM_TYPE, data: state };

    expect(stateFromEntry(entry)?.iteration).toBe(7);
  });

  test('rejects wrong tool name / custom type', () => {
    const state = seedState();

    expect(
      stateFromEntry({
        type: 'message',
        message: { role: 'toolResult', toolName: 'something-else', details: state },
      }),
    ).toBeNull();
    expect(stateFromEntry({ type: 'custom', customType: 'other-state', data: state })).toBeNull();
  });

  test('reduceBranch returns latest snapshot, or null when none', () => {
    expect(reduceBranch([])).toBeNull();

    const older = seedState({ iteration: 1 });
    const newer = seedState({ iteration: 5 });
    const branch: BranchEntry[] = [
      { type: 'message', message: { role: 'toolResult', toolName: ITERATION_TOOL_NAME, details: older } },
      { type: 'message', message: { role: 'toolResult', toolName: ITERATION_TOOL_NAME, details: newer } },
    ];

    expect(reduceBranch(branch)?.iteration).toBe(5);
  });
});
