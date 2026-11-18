/**
 * Tests for lib/node/pi/tts/status.ts.
 *
 * Pure `/tts status` line formatters - the probe / library shapes are plain
 * objects and clip durations are injected, so no live server, engine
 * runtime, or audio files are needed.
 */

import { describe, expect, test } from 'vitest';

import type { VoiceLibrary } from '../../../../../lib/node/pi/tts/engine.ts';
import {
  libraryHint,
  libraryLines,
  reachText,
  refClipHints,
  type ClipDuration,
} from '../../../../../lib/node/pi/tts/status.ts';
import type { ResolvedVoice } from '../../../../../lib/node/pi/tts/types.ts';

const library: VoiceLibrary = {
  default: 'placeholder',
  voices: [{ id: 'placeholder', lang: 'en', hasTranscript: true, aliases: ['alloy', 'echo'] }],
};
const preset = (preset: string): ResolvedVoice => ({
  name: 'narrator',
  voice: { kind: 'preset', preset },
  kind: 'preset',
});
const clone: ResolvedVoice = { name: 'c', voice: { kind: 'clone', refAudio: '/a.wav' }, kind: 'clone' };

describe('reachText', () => {
  test('reports the HTTP status when the server answered', () => {
    expect(reachText({ status: 200, timedOut: false })).toBe('reachable (200)');
    expect(reachText({ status: 503, timedOut: false })).toBe('reachable (503)');
  });

  test('reports a cold-start hint on a timeout', () => {
    expect(reachText({ status: undefined, timedOut: true })).toBe('no response yet (starting / cold?)');
  });

  test('reports UNREACHABLE on connection refusal', () => {
    expect(reachText({ status: undefined, timedOut: false })).toBe('UNREACHABLE');
  });
});

describe('libraryHint', () => {
  test('no library or a clone voice yields no hint', () => {
    expect(libraryHint(preset('nope'), undefined)).toBe('');
    expect(libraryHint(clone, library)).toBe('');
  });

  test('a library id or alias matches (case-insensitive)', () => {
    expect(libraryHint(preset('placeholder'), library)).toBe('');
    expect(libraryHint(preset('Alloy'), library)).toBe('');
  });

  test('the roster key is used when no preset field is set', () => {
    expect(libraryHint({ name: 'echo', voice: { kind: 'preset' }, kind: 'preset' }, library)).toBe('');
  });

  test('warns on an unknown name, naming the fallback', () => {
    expect(libraryHint(preset('ryan'), library)).toBe(
      '  ! preset "ryan" is not in the server voice library; it falls back to the default "placeholder"',
    );
    expect(libraryHint(preset('ryan'), { voices: [] })).toBe(
      '  ! preset "ryan" is not in the server voice library; it falls back to the server default',
    );
  });
});

describe('libraryLines', () => {
  test('lists voices with the default marked', () => {
    expect(libraryLines(library)).toEqual(['server voices:', '  placeholder [default] (en) aliases: alloy, echo']);
  });

  test('flags a voice without a transcript', () => {
    expect(libraryLines({ voices: [{ id: 'v', hasTranscript: false, aliases: [] }] })).toEqual([
      'server voices:',
      '  v (no transcript)',
    ]);
  });

  test('unavailable and empty libraries', () => {
    expect(libraryLines(undefined)).toEqual(['server voices: (unavailable)']);
    expect(libraryLines({ voices: [] })).toEqual(['server voices: (none)']);
  });
});

describe('refClipHints', () => {
  const durations: Record<string, ClipDuration> = { '/ok.wav': 12, '/long.wav': 42.25, '/gone.wav': 'missing' };
  const durationOf = (p: string): ClipDuration => durations[p];

  test('no hints for short or unknown-duration clips', () => {
    expect(refClipHints({ kind: 'clone', refAudio: '/ok.wav' }, durationOf)).toEqual([]);
    expect(refClipHints({ kind: 'clone', refAudio: '/clip.mp3' }, durationOf)).toEqual([]);
  });

  test('warns on long and unreadable clips across emotes, once per path', () => {
    expect(
      refClipHints(
        {
          kind: 'clone',
          refAudio: '/long.wav',
          emotes: [
            { match: ['a'], refAudio: '/gone.wav', refText: '' },
            { match: ['b'], refAudio: '/long.wav', refText: '' },
          ],
        },
        durationOf,
      ),
    ).toEqual([
      '  ! reference clip /long.wav is 42.3 s; ICL needs <= 30 s (falls back to the speaker embedding)',
      '  ! reference clip /gone.wav is unreadable; clone synth will fail',
    ]);
  });
});
