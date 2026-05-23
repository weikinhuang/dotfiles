/**
 * Tests for lib/node/pi/waveform-indicator/suffix.ts.
 *
 * Pure helpers, no pi runtime - state transitions are exercised with
 * plain object literals rather than fake-timer / fake-streaming setup.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type LabelSuffixState,
  STILL_THINKING_THRESHOLD_MS,
  dimText,
  formatElapsed,
  formatSuffix,
  formatThinkingEffort,
  formatTokens,
  newLabelSuffixState,
  pulseDimText,
  resetTurnState,
} from '../../../../../lib/node/pi/waveform-indicator/suffix.ts';

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const SGR_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

function makeState(overrides: Partial<LabelSuffixState> = {}): LabelSuffixState {
  return {
    ...newLabelSuffixState(0),
    ...overrides,
  };
}

/**
 * Force the SGR styling on regardless of the host's NO_COLOR / TTY
 * state so the bulk of the spec sees today's behaviour. The dedicated
 * NO_COLOR / non-TTY tests below restore + override these per-test.
 */
let savedNoColor: string | undefined;
let savedIsTTY: unknown;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  savedIsTTY = (process.stdout as { isTTY?: unknown }).isTTY;
  (process.stdout as { isTTY?: unknown }).isTTY = true;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  (process.stdout as { isTTY?: unknown }).isTTY = savedIsTTY;
});

/** Pull the RGB channel value out of `\x1b[2;38;2;v;v;vm…\x1b[0m`. */
function extractPulseChannel(s: string): number | undefined {
  const m = /\x1b\[2;38;2;(\d+);(\d+);(\d+)m/.exec(s);
  if (m === null) return undefined;
  const r = Number(m[1]);
  if (Number(m[2]) !== r || Number(m[3]) !== r) return undefined;
  return r;
}

// ──────────────────────────────────────────────────────────────────────
// formatElapsed
// ──────────────────────────────────────────────────────────────────────

describe('formatElapsed', () => {
  test('sub-second collapses to 0s', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
  });

  test('floors to whole seconds', () => {
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(1999)).toBe('1s');
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(42_000)).toBe('42s');
  });

  test('1m boundary uses minute format', () => {
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(78_000)).toBe('1m 18s');
    expect(formatElapsed(123_000)).toBe('2m 3s');
  });

  test('1h boundary uses hour format', () => {
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(7_380_000)).toBe('2h 3m');
  });

  test('negative and non-finite collapse to 0s', () => {
    expect(formatElapsed(-1)).toBe('0s');
    expect(formatElapsed(-1_000_000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatTokens
// ──────────────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  test('raw integer below 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(185)).toBe('185');
    expect(formatTokens(999)).toBe('999');
  });

  test('thousands always carry one decimal (claude shows 2.0k, not 2k)', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1300)).toBe('1.3k');
    expect(formatTokens(1700)).toBe('1.7k');
    expect(formatTokens(2000)).toBe('2.0k');
    expect(formatTokens(2500)).toBe('2.5k');
    expect(formatTokens(3600)).toBe('3.6k');
  });

  test('thousands round to one decimal', () => {
    expect(formatTokens(1349)).toBe('1.3k');
    expect(formatTokens(1350)).toBe('1.4k');
    expect(formatTokens(1399)).toBe('1.4k');
  });

  test('millions use M suffix with one decimal', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  test('non-finite and non-positive collapse to 0', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(Number.NEGATIVE_INFINITY)).toBe('0');
  });

  test('rounds the underlying integer count, not the divided value', () => {
    // 1.4 tokens shouldn't ever be a real input; just guarding against fractional.
    expect(formatTokens(1.4)).toBe('1');
    expect(formatTokens(999.6)).toBe('1.0k');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatThinkingEffort
// ──────────────────────────────────────────────────────────────────────

describe('formatThinkingEffort', () => {
  test('returns undefined for off / minimal regardless of state', () => {
    const active = makeState({
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: 0,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(active, 'off', 5_000)).toBeUndefined();
    expect(formatThinkingEffort(active, 'minimal', 5_000)).toBeUndefined();
  });

  test('returns "thinking with <level> effort" while in-block under threshold', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: 1_000,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'low', 5_000)).toBe('thinking with low effort');
    expect(formatThinkingEffort(state, 'medium', 5_000)).toBe('thinking with medium effort');
    expect(formatThinkingEffort(state, 'high', 5_000)).toBe('thinking with high effort');
  });

  test('renders xhigh as "extra-high effort" so the prose reads naturally', () => {
    const active = makeState({
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: 1_000,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(active, 'xhigh', 5_000)).toBe('thinking with extra-high effort');
    expect(formatThinkingEffort(active, 'xhigh', 30_000)).toBe('still thinking with extra-high effort');
  });

  test('switches to "still thinking" once in-block hits the 20s threshold', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: 0,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'medium', STILL_THINKING_THRESHOLD_MS - 1)).toBe('thinking with medium effort');
    expect(formatThinkingEffort(state, 'medium', STILL_THINKING_THRESHOLD_MS)).toBe(
      'still thinking with medium effort',
    );
    expect(formatThinkingEffort(state, 'medium', 60_000)).toBe('still thinking with medium effort');
  });

  test('"still thinking" timer is keyed on activeStartedAtMs (restarts per block)', () => {
    // Block 1 already cumulated 25s; block 2 just started at t=30000.
    const state = makeState({
      thinking: {
        cumulativeMs: 25_000,
        activeStartedAtMs: 30_000,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    // 5s into block 2 → still under 20s threshold for THIS block.
    expect(formatThinkingEffort(state, 'medium', 35_000)).toBe('thinking with medium effort');
    // 20s into block 2 → "still thinking" kicks in.
    expect(formatThinkingEffort(state, 'medium', 50_000)).toBe('still thinking with medium effort');
  });

  test('renders "thought for Ns" once a block has ended and we are not currently thinking', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 4_000,
        activeStartedAtMs: undefined,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'medium', 60_000)).toBe('thought for 4s');
  });

  test('"thought for" is cumulative across all blocks this turn', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 33_000,
        activeStartedAtMs: undefined,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'high', 99_999)).toBe('thought for 33s');
  });

  test('"thought for" clamps to 1s minimum so a sub-second block does not render 0s', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 250,
        activeStartedAtMs: undefined,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'low', 5_000)).toBe('thought for 1s');
  });

  test('returns undefined when no block has run yet (idle / pre-thinking)', () => {
    const state = makeState();

    expect(formatThinkingEffort(state, 'medium', 5_000)).toBeUndefined();
  });

  test('active block takes precedence over hasFinishedAny (block 2 in progress)', () => {
    const state = makeState({
      thinking: {
        cumulativeMs: 25_000,
        activeStartedAtMs: 30_000,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    // While block 2 is active and no text has streamed since the
    // most recent thinking_start, render the live "thinking..."
    // segment, not the previous "thought for 25s" stamp.
    expect(formatThinkingEffort(state, 'medium', 35_000)).toBe('thinking with medium effort');
  });

  test('hides the segment once non-thinking content streams, even while activeStartedAtMs is still set', () => {
    // Some providers (anthropic + extended thinking) keep the thinking
    // content block technically open while text streams alongside.
    // The visible-to-the-user behaviour wins: text is appearing, so
    // the thinking segment hides.
    const state = makeState({
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: 1_000,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: true,
      },
    });

    expect(formatThinkingEffort(state, 'medium', 5_000)).toBeUndefined();
  });

  test('hides the segment once non-thinking content (text / toolcall) starts streaming', () => {
    // thinking_end fired (cumulative 4s), then text_start arrived -
    // we should suppress "thought for Ns" while the model produces the
    // actual response.
    const state = makeState({
      thinking: {
        cumulativeMs: 4_000,
        activeStartedAtMs: undefined,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: true,
      },
    });

    expect(formatThinkingEffort(state, 'medium', 60_000)).toBeUndefined();
  });

  test('a new thinking block reopens the live segment even after non-thinking content streamed (interleaved thinking)', () => {
    // Block 1 ended (4s), text streamed. Then a new thinking_start
    // fired (block 2 active). The extension resets
    // hasStreamedNonThinkingContent to false on thinking_start so the
    // formatter renders the live "thinking..." segment again.
    const state = makeState({
      thinking: {
        cumulativeMs: 4_000,
        activeStartedAtMs: 65_000,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: false,
      },
    });

    expect(formatThinkingEffort(state, 'medium', 70_000)).toBe('thinking with medium effort');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatSuffix
// ──────────────────────────────────────────────────────────────────────

describe('formatSuffix', () => {
  test('elapsed-only when no usage and no thinking', () => {
    const state = newLabelSuffixState(0);

    expect(formatSuffix(state, 'off', 5_000)).toBe('(5s)');
  });

  test('uplink phase shows ↑ <input> tokens', () => {
    const state = newLabelSuffixState(0);
    state.currentUsage = { input: 185, output: 0 };

    expect(formatSuffix(state, 'off', 5_000)).toBe('(5s · ↑ 185 tokens)');
  });

  test('downlink phase shows ↓ <output> tokens', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.currentUsage = { input: 200, output: 1300 };

    expect(formatSuffix(state, 'off', 22_000)).toBe('(22s · ↓ 1.3k tokens)');
  });

  test('token segment is suppressed when the relevant direction is 0', () => {
    // uplink with 0 input tokens - nothing landed on the wire yet.
    const a = newLabelSuffixState(0);

    expect(formatSuffix(a, 'off', 5_000)).toBe('(5s)');

    // downlink with 0 output tokens - response just started, no text yet.
    const b = newLabelSuffixState(0);
    b.phase = 'downlink';

    expect(formatSuffix(b, 'off', 5_000)).toBe('(5s)');
  });

  test('combines token totals across committed and current messages', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.committedUsage = { input: 500, output: 1700 };
    state.currentUsage = { input: 200, output: 800 };

    // 1700 + 800 = 2500 → 2.5k.
    expect(formatSuffix(state, 'off', 53_000)).toBe('(53s · ↓ 2.5k tokens)');
  });

  test('inputDeltaTokens floors the ↑ segment when the provider has not streamed real input usage (caller passes per-turn delta)', () => {
    // Provider sent zeros for partial.usage.input throughout streaming -
    // we still want to render an honest input count from the very first
    // tick. Caller passes the per-turn delta of getContextUsage().
    const state = newLabelSuffixState(0);

    expect(formatSuffix(state, 'off', 5_000, { inputDeltaTokens: 1_280 })).toBe('(5s · ↑ 1.3k tokens)');
  });

  test('real input usage trumps a smaller inputDeltaTokens floor', () => {
    // Once the provider has actually streamed input usage that exceeds
    // the caller's floor, prefer the real number so we don't regress
    // the displayed count.
    const state = newLabelSuffixState(0);
    state.committedUsage.input = 2_500;

    expect(formatSuffix(state, 'off', 5_000, { inputDeltaTokens: 1_000 })).toBe('(5s · ↑ 2.5k tokens)');
  });

  test('downlink falls back to delta-byte estimate when partial.usage.output is zero', () => {
    // ~800 bytes of streamed text → ~200 tokens at 4 bytes/token.
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.currentMessageOutputBytes = 800;

    expect(formatSuffix(state, 'off', 5_000)).toBe('(5s · ↓ 200 tokens)');
  });

  test('downlink prefers real partial.usage.output over the byte estimate when it is larger', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.currentUsage = { input: 0, output: 759 };
    // Estimate would have been 800 / 4 = 200 - real usage wins.
    state.currentMessageOutputBytes = 800;

    expect(formatSuffix(state, 'off', 22_000)).toBe('(22s · ↓ 759 tokens)');
  });

  test('downlink byte estimate adds onto previously-committed output tokens', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.committedUsage.output = 1_500;
    // Previous turns committed 1.5k; current message has streamed 1200
    // bytes ≈ 300 tokens → displayed 1.8k.
    state.currentMessageOutputBytes = 1_200;

    expect(formatSuffix(state, 'off', 30_000)).toBe('(30s · ↓ 1.8k tokens)');
  });

  test('appends thinking segment when applicable, in the documented order', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.currentUsage = { input: 0, output: 759 };
    state.thinking.activeStartedAtMs = 0;

    expect(formatSuffix(state, 'medium', 22_000)).toBe('(22s · ↓ 759 tokens · still thinking with medium effort)');
  });

  test('thought-for stamp persists into answer phase (claude example: 42s · ↑ 1.7k tokens · thought for 4s)', () => {
    const state = newLabelSuffixState(0);
    // Per spec, between turns phase swings back to uplink with cumulative counts.
    state.phase = 'uplink';
    state.committedUsage = { input: 1700, output: 0 };
    state.thinking = {
      cumulativeMs: 4_000,
      activeStartedAtMs: undefined,
      hasFinishedAny: true,
      hasStreamedNonThinkingContent: false,
    };

    expect(formatSuffix(state, 'medium', 42_000)).toBe('(42s · ↑ 1.7k tokens · thought for 4s)');
  });

  test('matches the full claude-code shape: 1m 18s · ↑ 3.6k tokens', () => {
    const state = newLabelSuffixState(0);
    state.phase = 'uplink';
    state.committedUsage = { input: 3_600, output: 0 };

    expect(formatSuffix(state, 'off', 78_000)).toBe('(1m 18s · ↑ 3.6k tokens)');
  });
});

// ──────────────────────────────────────────────────────────────────────
// state lifecycle helpers
// ──────────────────────────────────────────────────────────────────────

describe('newLabelSuffixState', () => {
  test('produces an idle uplink state with zeroed counters', () => {
    const state = newLabelSuffixState(123_456);

    expect(state).toEqual<LabelSuffixState>({
      loopStartedAtMs: 123_456,
      phase: 'uplink',
      committedUsage: { input: 0, output: 0 },
      currentUsage: undefined,
      currentMessageOutputBytes: 0,
      thinking: {
        cumulativeMs: 0,
        activeStartedAtMs: undefined,
        hasFinishedAny: false,
        hasStreamedNonThinkingContent: false,
      },
    });
  });
});

describe('resetTurnState', () => {
  test('clears all turn-level fields (phase / committed / current / streamed bytes / thinking) but preserves loop start', () => {
    const state: LabelSuffixState = {
      loopStartedAtMs: 100,
      phase: 'downlink',
      committedUsage: { input: 500, output: 1700 },
      currentUsage: { input: 200, output: 800 },
      currentMessageOutputBytes: 1234,
      thinking: {
        cumulativeMs: 4_000,
        activeStartedAtMs: 50,
        hasFinishedAny: true,
        hasStreamedNonThinkingContent: true,
      },
    };
    resetTurnState(state);

    expect(state.loopStartedAtMs).toBe(100);
    expect(state.phase).toBe('uplink');
    expect(state.committedUsage).toEqual({ input: 0, output: 0 });
    expect(state.currentUsage).toBeUndefined();
    expect(state.currentMessageOutputBytes).toBe(0);
    expect(state.thinking).toEqual({
      cumulativeMs: 0,
      activeStartedAtMs: undefined,
      hasFinishedAny: false,
      hasStreamedNonThinkingContent: false,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// dimText
// ──────────────────────────────────────────────────────────────────────

describe('dimText', () => {
  test('wraps text in faint + grey-245 SGR and full reset', () => {
    expect(dimText('hi')).toBe('\x1b[2;38;5;245mhi\x1b[0m');
  });

  test('preserves the inner text byte-for-byte', () => {
    const inner = '(5s · ↑ 185 tokens · thinking with medium effort)';

    expect(stripAnsi(dimText(inner))).toBe(inner);
  });

  test('handles empty string', () => {
    expect(dimText('')).toBe('\x1b[2;38;5;245m\x1b[0m');
  });

  test('NO_COLOR (any non-empty value) short-circuits to unstyled text', () => {
    process.env.NO_COLOR = '1';

    expect(dimText('hi')).toBe('hi');

    process.env.NO_COLOR = 'yes please';

    expect(dimText('hi')).toBe('hi');
  });

  test('empty NO_COLOR does not suppress styling (matches the env convention)', () => {
    process.env.NO_COLOR = '';

    expect(dimText('hi')).toBe('\x1b[2;38;5;245mhi\x1b[0m');
  });

  test('process.stdout.isTTY === false short-circuits to unstyled text', () => {
    (process.stdout as { isTTY?: unknown }).isTTY = false;

    expect(dimText('hi')).toBe('hi');
  });
});

// ──────────────────────────────────────────────────────────────────────
// pulseDimText
// ──────────────────────────────────────────────────────────────────────

describe('pulseDimText', () => {
  test('tick=0 paints the brightest frame (cos(0) = 1 → centre + depth)', () => {
    // Defaults: centre 138, depth 15 → peak 153.
    const ch = extractPulseChannel(pulseDimText('thinking', 0));

    expect(ch).toBe(153);
  });

  test('tick=0 with custom depth still peaks at centre + depth', () => {
    const ch = extractPulseChannel(pulseDimText('thinking', 0, { breatheDepth: 25 }));

    expect(ch).toBe(163);
  });

  test('trough is dimmer than baseline grey-245 (138)', () => {
    // With default 0.5 Hz @ 20 FPS the cosine hits -1 at tick=20.
    const ch = extractPulseChannel(pulseDimText('thinking', 20));

    expect(ch).toBeDefined();
    expect(ch).toBeLessThan(138);
    expect(ch).toBe(123);
  });

  test('returns "" on empty input (helper short-circuits even though caller usually has)', () => {
    expect(pulseDimText('', 0)).toBe('');
    expect(pulseDimText('', 12, { breatheSpeed: 0.5, breatheDepth: 20 })).toBe('');
  });

  test('breatheSpeed <= 0 falls through to a static dim render (no pulse)', () => {
    expect(pulseDimText('thinking', 5, { breatheSpeed: 0 })).toBe('\x1b[2;38;5;245mthinking\x1b[0m');
    expect(pulseDimText('thinking', 5, { breatheSpeed: -1 })).toBe('\x1b[2;38;5;245mthinking\x1b[0m');
  });

  test('non-finite breatheSpeed falls through to a static dim render', () => {
    expect(pulseDimText('thinking', 5, { breatheSpeed: Number.NaN })).toBe('\x1b[2;38;5;245mthinking\x1b[0m');
    expect(pulseDimText('thinking', 5, { breatheSpeed: Number.POSITIVE_INFINITY })).toBe(
      '\x1b[2;38;5;245mthinking\x1b[0m',
    );
  });

  test("breatheDepth = 0 reproduces today's static dim render byte-for-byte", () => {
    expect(pulseDimText('thinking', 7, { breatheDepth: 0 })).toBe(dimText('thinking'));
  });

  test('channel value clamps to [0, 255] even with an absurd breatheDepth', () => {
    // tick=0 → cos=1 → centre + depth. Centre 138 + depth 1000 = 1138, must clamp to 255.
    const peak = extractPulseChannel(pulseDimText('thinking', 0, { breatheDepth: 1000 }));

    expect(peak).toBe(255);

    // tick=20 @ default 0.5 Hz → cos=-1 → centre - 1000 = -862, must clamp to 0.
    const trough = extractPulseChannel(pulseDimText('thinking', 20, { breatheDepth: 1000 }));

    expect(trough).toBe(0);
  });

  test('preserves inner text byte-for-byte', () => {
    const inner = 'still thinking with medium effort';

    expect(stripAnsi(pulseDimText(inner, 0))).toBe(inner);
  });

  test('NO_COLOR short-circuits to unstyled text', () => {
    process.env.NO_COLOR = '1';

    expect(pulseDimText('thinking', 0)).toBe('thinking');
  });

  test('non-TTY short-circuits to unstyled text', () => {
    (process.stdout as { isTTY?: unknown }).isTTY = false;

    expect(pulseDimText('thinking', 0)).toBe('thinking');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatSuffix - pulse two-pass render
// ──────────────────────────────────────────────────────────────────────

describe('formatSuffix pulse (opts.tick)', () => {
  function makeThinkingState(): LabelSuffixState {
    const state = newLabelSuffixState(0);
    state.phase = 'downlink';
    state.currentUsage = { input: 0, output: 759 };
    state.thinking.activeStartedAtMs = 0;
    return state;
  }

  test('wraps the thinking-effort segment in a truecolor pulse SGR and the rest in static dim', () => {
    const state = makeThinkingState();
    const out = formatSuffix(state, 'medium', 22_000, { tick: 0 });

    // Three SGR escapes: dim(prefix) + pulse(thinking) + dim(')').
    const escapes = out.match(SGR_RE) ?? [];

    expect(escapes.length).toBe(6);
    expect(stripAnsi(out)).toBe('(22s · ↓ 759 tokens · still thinking with medium effort)');
    expect(out).toContain('\x1b[2;38;5;245m(22s · ↓ 759 tokens · \x1b[0m');
    expect(out).toContain('\x1b[2;38;5;245m)\x1b[0m');
    // Pulse SGR present, peak channel for tick=0.
    expect(extractPulseChannel(out)).toBe(153);
  });

  test('tick=0 produces a brighter channel than the trough at tick=20', () => {
    const state = makeThinkingState();
    const peak = extractPulseChannel(formatSuffix(state, 'medium', 22_000, { tick: 0 }));
    const trough = extractPulseChannel(formatSuffix(state, 'medium', 22_000, { tick: 20 }));

    expect(peak).toBe(153);
    expect(trough).toBe(123);
    expect(peak).toBeGreaterThan(trough!);
  });

  test('segment-suppressed states emit no pulse SGR (falls back to single dim wrap)', () => {
    // No thinking segment at all (level=off + no thinking blocks):
    const idle = newLabelSuffixState(0);
    const idleOut = formatSuffix(idle, 'off', 5_000, { tick: 0 });

    expect(idleOut).toBe('\x1b[2;38;5;245m(5s)\x1b[0m');
    // No truecolor pulse escape anywhere.
    expect(extractPulseChannel(idleOut)).toBeUndefined();

    // Non-thinking content has streamed → thinking segment suppressed:
    const streamed = makeThinkingState();
    streamed.thinking.hasStreamedNonThinkingContent = true;
    const streamedOut = formatSuffix(streamed, 'medium', 22_000, { tick: 0 });

    expect(stripAnsi(streamedOut)).toBe('(22s · ↓ 759 tokens)');
    expect(extractPulseChannel(streamedOut)).toBeUndefined();
  });

  test("breatheDepth=0 emits no pulse SGR and renders the same visible text as today's static dim", () => {
    const state = makeThinkingState();
    const out = formatSuffix(state, 'medium', 22_000, { tick: 0, breatheDepth: 0 });

    // No truecolor pulse SGR - all SGR escapes are the grey-245 baseline.
    expect(extractPulseChannel(out)).toBeUndefined();
    expect(stripAnsi(out)).toBe(stripAnsi(dimText(formatSuffix(state, 'medium', 22_000))));
    // Every SGR escape is either DIM_OPEN or the full reset.
    for (const sgr of out.match(SGR_RE) ?? []) {
      expect(sgr === '\x1b[2;38;5;245m' || sgr === '\x1b[0m').toBe(true);
    }
  });

  test("breatheSpeed <= 0 emits no pulse SGR and renders the same visible text as today's static dim", () => {
    const state = makeThinkingState();
    const plainText = stripAnsi(dimText(formatSuffix(state, 'medium', 22_000)));

    for (const breatheSpeed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = formatSuffix(state, 'medium', 22_000, { tick: 5, breatheSpeed });

      expect(extractPulseChannel(out)).toBeUndefined();
      expect(stripAnsi(out)).toBe(plainText);
    }
  });

  test('NO_COLOR short-circuits the whole pulse render to plain text', () => {
    process.env.NO_COLOR = '1';
    const state = makeThinkingState();
    const out = formatSuffix(state, 'medium', 22_000, { tick: 0 });

    expect(out).toBe('(22s · ↓ 759 tokens · still thinking with medium effort)');
    expect(out.match(SGR_RE)).toBeNull();
  });

  test("omitting opts.tick preserves today's plain unstyled return shape", () => {
    const state = makeThinkingState();

    expect(formatSuffix(state, 'medium', 22_000)).toBe('(22s · ↓ 759 tokens · still thinking with medium effort)');
    expect(formatSuffix(state, 'medium', 22_000, {})).toBe('(22s · ↓ 759 tokens · still thinking with medium effort)');
  });
});
