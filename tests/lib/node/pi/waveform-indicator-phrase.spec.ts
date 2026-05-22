/**
 * Tests for lib/node/pi/waveform-indicator-phrase.ts.
 *
 * Pure module - no pi runtime - so state transitions are exercised
 * directly against the reducer.
 */

import { describe, expect, test } from 'vitest';

import {
  type WaveformPhraseState,
  DEFAULT_MAX_PHRASE_CHARS,
  FALLBACK_PHRASE,
  abortInFlight,
  acceptPhrase,
  buildPhrasePrompt,
  digestPrompt,
  digestToolCall,
  issueRequest,
  markFiredThisTurn,
  newWaveformPhraseState,
  resetTurn,
  validatePhrase,
} from '../../../../lib/node/pi/waveform-indicator-phrase.ts';

// ──────────────────────────────────────────────────────────────────────
// validatePhrase
// ──────────────────────────────────────────────────────────────────────

describe('validatePhrase', () => {
  test('returns the cleaned phrase for a typical present-participle response', () => {
    expect(validatePhrase('Tracing imports...')).toBe('Tracing imports...');
  });

  test('trims surrounding whitespace before validating', () => {
    expect(validatePhrase('   Pondering...   ')).toBe('Pondering...');
  });

  test('rejects empty / whitespace-only strings', () => {
    expect(validatePhrase('')).toBeNull();
    expect(validatePhrase('   ')).toBeNull();
  });

  test('rejects the literal `null` escape hatch', () => {
    expect(validatePhrase('null')).toBeNull();
    // padded `null` still rejects after trim
    expect(validatePhrase('  null  ')).toBeNull();
  });

  test('rejects multi-line responses', () => {
    expect(validatePhrase('Tracing imports...\nPondering...')).toBeNull();
    expect(validatePhrase('first\rsecond')).toBeNull();
  });

  test('rejects ANSI SGR escapes (model smuggled colour)', () => {
    const ESC = String.fromCharCode(0x1b);
    expect(validatePhrase(ESC + '[31mTracing...' + ESC + '[0m')).toBeNull();
  });

  test('rejects bare control characters', () => {
    const BEL = String.fromCharCode(0x07);
    const DEL = String.fromCharCode(0x7f);
    expect(validatePhrase('Tracing' + BEL + '...')).toBeNull();
    expect(validatePhrase('Pondering' + DEL)).toBeNull();
  });

  test('truncates phrases exceeding the default 60-char cap with U+2026', () => {
    const result = validatePhrase('Polishing the very long abstract syntax tree of every single file in the repo...');
    expect(result).not.toBeNull();
    expect(result).toMatch(/…$/u);
    expect(Array.from(result ?? '').length).toBe(60);
    expect(result?.startsWith('Polishing the very long')).toBe(true);
  });

  test('respects a custom char cap (truncates, does not reject)', () => {
    const truncated = validatePhrase('Tracing imports...', { maxChars: 10 });
    expect(truncated).not.toBeNull();
    expect(truncated).toMatch(/…$/u);
    expect(Array.from(truncated ?? '').length).toBe(10);
    expect(truncated?.startsWith('Tracing')).toBe(true);
    // Under-cap inputs pass through unchanged.
    expect(validatePhrase('Hi...', { maxChars: 10 })).toBe('Hi...');
  });

  test('truncation strips ASCII dots before the ellipsis so we never get "....…"', () => {
    const result = validatePhrase('Verbing the long noun phrase here...', { maxChars: 10 });
    // chars.slice(0, 9) = "Verbing t"; stripTrailingPunctuation no-op; append "…".
    expect(result).toBe('Verbing t…');
  });

  test('counts user-visible characters via Array.from (surrogate-pair safe)', () => {
    // 1 emoji + 25 chars would be 26 visible chars - exceeds cap, but
    // we only test the surrogate-pair-counts-as-one rule with a short
    // emoji + word combo to stay well inside the budget.
    expect(validatePhrase('🌀 spinning...')).toBeNull(); // starts with non-letter
    // letter then emoji - emoji counts as one char
    expect(validatePhrase('Spinning 🌀...')).toBe('Spinning 🌀...');
  });

  test('rejects phrases that open on a non-letter (bullet, quote, digit)', () => {
    expect(validatePhrase('• Tracing...')).toBeNull();
    expect(validatePhrase('"Tracing imports..."')).toBeNull();
    expect(validatePhrase('1. Tracing...')).toBeNull();
  });

  test('exposes DEFAULT_MAX_PHRASE_CHARS as a public constant', () => {
    expect(DEFAULT_MAX_PHRASE_CHARS).toBe(60);
  });
});

// ──────────────────────────────────────────────────────────────────────
// digestPrompt / digestToolCall - determinism
// ──────────────────────────────────────────────────────────────────────

describe('digestPrompt', () => {
  test('collapses whitespace and trims', () => {
    expect(digestPrompt('  foo\n\tbar    baz  ')).toBe('foo bar baz');
  });

  test('strips control characters', () => {
    const BEL = String.fromCharCode(0x07);
    const ESC = String.fromCharCode(0x1b);
    expect(digestPrompt('hello' + BEL + ESC + 'world')).toBe('hello world');
  });

  test('caps output at the configured length', () => {
    const long = 'a'.repeat(300);
    expect(digestPrompt(long, 50).length).toBe(50);
  });

  test('strips trailing punctuation after truncation', () => {
    expect(digestPrompt('refactor the function:', 22)).toBe('refactor the function');
  });

  test('is deterministic for the same input', () => {
    const input = 'Implement section 3 ("Persona-driven tiny-model Thinking... head")';
    expect(digestPrompt(input)).toBe(digestPrompt(input));
  });

  test('non-string input returns empty string', () => {
    // intentionally loose: callers must not blow up on bad payloads
    expect(digestPrompt(undefined as unknown as string)).toBe('');
    expect(digestPrompt(null as unknown as string)).toBe('');
  });
});

describe('digestToolCall', () => {
  test('joins name + first N chars of stringified args', () => {
    expect(digestToolCall('bash', { command: 'ls -la' })).toBe('bash {"command":"ls -la"}');
  });

  test('handles string args without re-stringifying', () => {
    expect(digestToolCall('read', 'src/lib.ts')).toBe('read src/lib.ts');
  });

  test('caps the args portion at the configured length', () => {
    const longCmd = 'a'.repeat(300);
    const out = digestToolCall('bash', longCmd, 20);
    expect(out.length).toBe('bash '.length + 20);
  });

  test('null / undefined args fall back to the tool name only', () => {
    expect(digestToolCall('grep', undefined)).toBe('grep');
    expect(digestToolCall('grep', null)).toBe('grep');
  });

  test('handles unserializable args without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(digestToolCall('bash', cyclic)).toBe('bash');
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildPhrasePrompt - shape snapshot
// ──────────────────────────────────────────────────────────────────────

describe('buildPhrasePrompt', () => {
  test('snapshot: standard phaseTag + digest', () => {
    const out = buildPhrasePrompt('reasoning about', 'refactor the function');
    expect(out).toBe(
      [
        'Never call tools, never read files, never run commands. Reply with one short present-participle phrase only.',
        '',
        'phaseTag: reasoning about',
        'contextDigest: refactor the function',
        '',
        'If you cannot produce a valid phrase, reply with the literal string null.',
      ].join('\n'),
    );
  });

  test('omits the contextDigest line when the digest is empty', () => {
    const out = buildPhrasePrompt('starting work on', '');
    expect(out).not.toMatch(/contextDigest/);
    expect(out).toMatch(/phaseTag: starting work on/);
  });

  test('shows `(none)` when phaseTag is empty', () => {
    expect(buildPhrasePrompt('', 'foo')).toMatch(/phaseTag: \(none\)/);
  });

  test('opens with the no-tool-use directive', () => {
    expect(buildPhrasePrompt('using bash', 'ls -la').split('\n')[0]).toMatch(/Never call tools/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// firedThisTurn / resetTurn dedup
// ──────────────────────────────────────────────────────────────────────

describe('firedThisTurn dedup', () => {
  test('first call for a tag returns false; second returns true', () => {
    const state = newWaveformPhraseState();
    expect(markFiredThisTurn(state, 'thinking_start')).toBe(false);
    expect(markFiredThisTurn(state, 'thinking_start')).toBe(true);
  });

  test('different tags are tracked independently', () => {
    const state = newWaveformPhraseState();
    expect(markFiredThisTurn(state, 'thinking_start')).toBe(false);
    expect(markFiredThisTurn(state, 'text_start')).toBe(false);
    expect(markFiredThisTurn(state, 'thinking_start')).toBe(true);
  });

  test('resetTurn clears the set so next turn re-fires', () => {
    const state = newWaveformPhraseState();
    markFiredThisTurn(state, 'thinking_start');
    resetTurn(state);
    expect(markFiredThisTurn(state, 'thinking_start')).toBe(false);
  });

  test('resetTurn preserves the accepted phrase + counters', () => {
    const state = newWaveformPhraseState();
    issueRequest(state, undefined);
    acceptPhrase(state, 1, 'Tracing imports...', state.controller?.signal);
    markFiredThisTurn(state, 'thinking_start');
    resetTurn(state);
    expect(state.acceptedPhrase).toBe('Tracing imports...');
    expect(state.lastAcceptedRequestId).toBe(1);
    expect(state.callsThisSession).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Coalescing reducer: issueRequest + acceptPhrase
// ──────────────────────────────────────────────────────────────────────

describe('issueRequest + acceptPhrase', () => {
  test('issueRequest mints monotonically increasing ids', () => {
    const state = newWaveformPhraseState();
    expect(issueRequest(state, undefined).requestId).toBe(1);
    expect(issueRequest(state, undefined).requestId).toBe(2);
    expect(issueRequest(state, undefined).requestId).toBe(3);
  });

  test('issueRequest bumps callsThisSession', () => {
    const state = newWaveformPhraseState();
    issueRequest(state, undefined);
    issueRequest(state, undefined);
    expect(state.callsThisSession).toBe(2);
  });

  test('issueRequest aborts the previous controller', () => {
    const state = newWaveformPhraseState();
    const first = issueRequest(state, undefined);
    expect(first.signal.aborted).toBe(false);
    issueRequest(state, undefined);
    expect(first.signal.aborted).toBe(true);
  });

  test('first accept replaces the fallback exactly once', () => {
    const state = newWaveformPhraseState();
    expect(state.acceptedPhrase).toBeUndefined();
    const { requestId, signal } = issueRequest(state, undefined);
    expect(acceptPhrase(state, requestId, 'Tracing imports...', signal)).toBe('accepted');
    expect(state.acceptedPhrase).toBe('Tracing imports...');
    expect(state.lastAcceptedRequestId).toBe(requestId);
  });

  test('stale id (older than lastAcceptedRequestId) is dropped', () => {
    // Manually advance lastAcceptedRequestId past the request id we're
    // about to land. In practice the older request's controller would
    // also have been aborted (issueRequest aborts the previous one),
    // but that's the `cancelled` path - this test exercises the
    // `stale` guard on its own, so we hand acceptPhrase a fresh
    // un-aborted signal.
    const state = newWaveformPhraseState();
    state.lastAcceptedRequestId = 5;
    state.acceptedPhrase = 'Pondering...';
    const fresh = new AbortController();
    expect(acceptPhrase(state, 3, 'Tracing...', fresh.signal)).toBe('stale');
    expect(state.acceptedPhrase).toBe('Pondering...');
  });

  test('aborted controller wins over stale check (cancelled is reported)', () => {
    // When a new trigger fires before an old spawn returns, the older
    // request's signal is already aborted - aborted-in-flight is the
    // more informative diagnostic than stale-id, so we report
    // `cancelled` first.
    const state = newWaveformPhraseState();
    const a = issueRequest(state, undefined);
    const b = issueRequest(state, undefined);
    acceptPhrase(state, b.requestId, 'Pondering...', b.signal);
    expect(acceptPhrase(state, a.requestId, 'Tracing...', a.signal)).toBe('cancelled');
    expect(state.acceptedPhrase).toBe('Pondering...');
  });

  test('aborted-in-flight response is dropped as cancelled', () => {
    const state = newWaveformPhraseState();
    const { requestId, signal } = issueRequest(state, undefined);
    // Abort BEFORE accepting
    state.controller?.abort();
    expect(acceptPhrase(state, requestId, 'Tracing...', signal)).toBe('cancelled');
    expect(state.acceptedPhrase).toBeUndefined();
  });

  test('parent signal abort propagates through the merged signal', () => {
    const state = newWaveformPhraseState();
    const parent = new AbortController();
    const { signal } = issueRequest(state, parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  test('budget-exhausted path keeps last accepted phrase', () => {
    // The reducer doesn't enforce the budget itself - the extension
    // does so BEFORE calling issueRequest. This test exercises the
    // "previously-accepted phrase stays on screen" half of the
    // contract by simulating the extension's short-circuit: no new
    // request issued, no new accept fires, state.acceptedPhrase is
    // untouched.
    const state = newWaveformPhraseState();
    const { requestId, signal } = issueRequest(state, undefined);
    acceptPhrase(state, requestId, 'Tracing imports...', signal);
    // Budget exhausted - extension does NOT call issueRequest. The
    // phrase stays put.
    expect(state.acceptedPhrase).toBe('Tracing imports...');
    expect(state.callsThisSession).toBe(1);
  });

  test('abortInFlight is idempotent', () => {
    const state = newWaveformPhraseState();
    issueRequest(state, undefined);
    expect(() => {
      abortInFlight(state);
      abortInFlight(state);
    }).not.toThrow();
    expect(state.controller).toBeNull();
  });

  test('abortInFlight aborts the controller and clears it', () => {
    const state = newWaveformPhraseState();
    const { signal } = issueRequest(state, undefined);
    abortInFlight(state);
    expect(signal.aborted).toBe(true);
    expect(state.controller).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// FALLBACK_PHRASE
// ──────────────────────────────────────────────────────────────────────

describe('FALLBACK_PHRASE', () => {
  test('is the literal Thinking... string the extension renders by default', () => {
    expect(FALLBACK_PHRASE).toBe('Thinking...');
  });

  test('fresh state has no accepted phrase (callers fall back)', () => {
    const state: WaveformPhraseState = newWaveformPhraseState();
    expect(state.acceptedPhrase).toBeUndefined();
  });
});
