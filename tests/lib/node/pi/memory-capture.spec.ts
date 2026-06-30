/**
 * Tests for lib/node/pi/memory-capture.ts.
 *
 * Pure module - the should-nudge predicate is a function of an
 * injected closure-state snapshot, so tests just pass shapes.
 */

import { describe, expect, test } from 'vitest';

import {
  buildCandidateNudge,
  CAPTURE_NUDGE,
  type CaptureCandidate,
  type CaptureNudgeState,
  extractCandidatesFromSummary,
  selectCaptureCandidates,
  shouldNudgeCapture,
} from '../../../../lib/node/pi/memory-capture.ts';

const base: CaptureNudgeState = { userTurnsSinceLastSave: 0, readOnly: false, disabled: false };

describe('shouldNudgeCapture', () => {
  test('nudges when there is user activity since the last save', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 1 })).toBe(true);
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 5 })).toBe(true);
  });

  test('stays quiet when nothing has happened since the last save', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 0 })).toBe(false);
  });

  test('stays quiet when read-only even with user activity', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 3, readOnly: true })).toBe(false);
  });

  test('stays quiet when disabled even with user activity', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 3, disabled: true })).toBe(false);
  });

  test('disabled and read-only both suppress regardless of activity', () => {
    expect(shouldNudgeCapture({ userTurnsSinceLastSave: 9, readOnly: true, disabled: true })).toBe(false);
  });
});

describe('CAPTURE_NUDGE', () => {
  test('is a non-empty, stable timing reminder', () => {
    expect(typeof CAPTURE_NUDGE).toBe('string');
    expect(CAPTURE_NUDGE.length).toBeGreaterThan(0);
    expect(CAPTURE_NUDGE).toContain('compact');
    expect(CAPTURE_NUDGE).toContain('memory save');
  });
});

// A realistic compaction summary in the SUMMARIZATION_PROMPT format
// (Goal / Constraints & Preferences / Progress / Key Decisions / Next
// Steps / Critical Context), including a (none) placeholder and a real
// preference.
const SAMPLE_SUMMARY = [
  '## Goal',
  'Ship the memory capture-assist nudge.',
  '',
  '## Constraints & Preferences',
  '- Tabs, never spaces, for indentation',
  '- **Run oxlint before committing**',
  '- [x] Keep helpers pure and pi-free',
  '',
  '## Progress',
  '- Wired the session_compact handler',
  '',
  '## Key Decisions',
  '- Reuse the compaction summary instead of an extra model call',
  '',
  '## Next Steps',
  '- (none)',
  '',
  '## Critical Context',
  '- Eval ran against self-hosted Qwen',
].join('\n');

describe('extractCandidatesFromSummary', () => {
  test('parses both target sections and tags them', () => {
    const candidates = extractCandidatesFromSummary(SAMPLE_SUMMARY);
    expect(candidates).toContainEqual({ text: 'Tabs, never spaces, for indentation', section: 'preferences' });
    expect(candidates).toContainEqual({
      text: 'Reuse the compaction summary instead of an extra model call',
      section: 'decisions',
    });
  });

  test('orders preferences before decisions', () => {
    const candidates = extractCandidatesFromSummary(SAMPLE_SUMMARY);
    const lastPref = candidates.map((c) => c.section).lastIndexOf('preferences');
    const firstDecision = candidates.map((c) => c.section).indexOf('decisions');
    expect(lastPref).toBeLessThan(firstDecision);
  });

  test('stops collecting a section at the next ## header', () => {
    const candidates = extractCandidatesFromSummary(SAMPLE_SUMMARY);
    const texts = candidates.map((c) => c.text);
    // bullets under Goal / Progress / Next Steps / Critical Context must not leak in
    expect(texts).not.toContain('Ship the memory capture-assist nudge.');
    expect(texts).not.toContain('Wired the session_compact handler');
    expect(texts).not.toContain('Eval ran against self-hosted Qwen');
  });

  test('strips list markers, checkboxes, and bold', () => {
    const candidates = extractCandidatesFromSummary(SAMPLE_SUMMARY);
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain('Run oxlint before committing');
    expect(texts).toContain('Keep helpers pure and pi-free');
  });

  test('drops (none) and other placeholder bullets', () => {
    const summary = [
      '## Constraints & Preferences',
      '- (none)',
      '- (none were mentioned)',
      '- (not applicable)',
      '- Tabs, never spaces',
    ].join('\n');
    expect(extractCandidatesFromSummary(summary)).toEqual([{ text: 'Tabs, never spaces', section: 'preferences' }]);
  });

  test('drops template-leftover bullets', () => {
    const summary = [
      '## Constraints & Preferences',
      '- [Any constraints, preferences the user expressed]',
      '## Key Decisions',
      '- [Decision]: [rationale]',
      '- Use a closure flag',
    ].join('\n');
    expect(extractCandidatesFromSummary(summary)).toEqual([{ text: 'Use a closure flag', section: 'decisions' }]);
  });

  test('dedups on normalized text', () => {
    const summary = [
      '## Constraints & Preferences',
      '- Tabs, never spaces',
      '- tabs,   never   spaces',
      '- TABS, NEVER SPACES',
    ].join('\n');
    expect(extractCandidatesFromSummary(summary)).toHaveLength(1);
  });

  test('caps the result at 5 candidates', () => {
    const bullets = Array.from({ length: 9 }, (_, i) => `- preference number ${i}`);
    const summary = ['## Constraints & Preferences', ...bullets].join('\n');
    expect(extractCandidatesFromSummary(summary)).toHaveLength(5);
  });

  test('matches headers case-insensitively and tolerates trailing whitespace', () => {
    const summary = ['##  constraints & PREFERENCES   ', '- Tabs, never spaces'].join('\n');
    expect(extractCandidatesFromSummary(summary)).toEqual([{ text: 'Tabs, never spaces', section: 'preferences' }]);
  });

  test('returns [] for an empty summary', () => {
    expect(extractCandidatesFromSummary('')).toEqual([]);
  });

  test('returns [] when the target sections are missing', () => {
    const summary = ['## Goal', '- do a thing', '## Progress', '- did the thing'].join('\n');
    expect(extractCandidatesFromSummary(summary)).toEqual([]);
  });
});

describe('selectCaptureCandidates', () => {
  test('drops candidates the injected predicate marks as already saved', () => {
    const isAlreadySaved = (text: string): boolean => text === 'Tabs, never spaces, for indentation';
    const kept = selectCaptureCandidates(SAMPLE_SUMMARY, isAlreadySaved);
    const texts = kept.map((c) => c.text);
    expect(texts).not.toContain('Tabs, never spaces, for indentation');
    expect(texts).toContain('Reuse the compaction summary instead of an extra model call');
  });

  test('keeps every candidate when nothing is already saved', () => {
    const all = extractCandidatesFromSummary(SAMPLE_SUMMARY);
    const kept = selectCaptureCandidates(SAMPLE_SUMMARY, () => false);
    expect(kept).toEqual(all);
  });

  test('returns [] when everything is already saved', () => {
    expect(selectCaptureCandidates(SAMPLE_SUMMARY, () => true)).toEqual([]);
  });
});

describe('buildCandidateNudge', () => {
  const candidates: CaptureCandidate[] = [
    { text: 'Tabs, never spaces, for indentation', section: 'preferences' },
    { text: 'Reuse the compaction summary', section: 'decisions' },
  ];

  test('returns null when there are no candidates', () => {
    expect(buildCandidateNudge([])).toBeNull();
  });

  test('lists each candidate text and mentions memory save', () => {
    const body = buildCandidateNudge(candidates);
    expect(body).not.toBeNull();
    expect(body).toContain('- Tabs, never spaces, for indentation');
    expect(body).toContain('- Reuse the compaction summary');
    expect(body).toContain('memory save');
  });

  test('stays reasonably short', () => {
    const body = buildCandidateNudge(candidates) ?? '';
    expect(body.length).toBeLessThan(600);
  });
});
