/**
 * Tests for lib/node/pi/tts/engine.ts - pure request-body builders, the
 * language normalization, and the voice-library parser. Network synth
 * (`synthesize`, `synthesizeStream`, the probes, `setGptSovitsWeights`) is
 * intentionally not exercised here.
 */

import { expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../../../../../lib/node/pi/tts/config.ts';
import {
  buildCloneBody,
  buildSpeechBody,
  langForServer,
  parseVoiceLibrary,
} from '../../../../../lib/node/pi/tts/engine.ts';
import type { Reference, ResolvedVoice, TtsConfig, VoiceConfig } from '../../../../../lib/node/pi/tts/types.ts';

/** A single deep-equality case: name, lazily-evaluated actual, expected. */
type Case = [name: string, got: () => unknown, want: unknown];

const cfg: TtsConfig = { ...DEFAULT_CONFIG, model: 'tts', format: 'wav' };
const mp3Cfg: TtsConfig = { ...cfg, format: 'mp3' };
const presetResolved: ResolvedVoice = {
  name: 'narrator',
  voice: { kind: 'preset', preset: 'alloy', promptLang: 'en' },
  kind: 'preset',
};

const cloneVoice: VoiceConfig = { kind: 'clone', refAudio: '/d.wav', refText: 'default', promptLang: 'en' };
const iclRef: Reference = { refAudio: '/up.wav', refText: 'upbeat line' };
const noTextRef: Reference = { refAudio: '/x.wav', refText: '   ' };
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const cases: Case[] = [
  // ── langForServer ──────────────────────────────────────────────────
  ['lang: undefined -> omitted', () => langForServer(undefined), undefined],
  ['lang: blank -> omitted', () => langForServer('  '), undefined],
  ['lang: auto -> omitted (llama.cpp 500s on it)', () => langForServer('Auto'), undefined],
  ['lang: unknown -> omitted', () => langForServer('klingon'), undefined],
  ['lang: code passes through', () => langForServer('en'), 'en'],
  ['lang: code case-folded', () => langForServer(' JA '), 'ja'],
  ['lang: full name case-folded', () => langForServer('English'), 'english'],

  // ── buildSpeechBody (preset / library voice) ───────────────────────
  [
    'speech: OpenAI fields only',
    () => buildSpeechBody(cfg, presetResolved, 'hello there'),
    { model: 'tts', input: 'hello there', voice: 'alloy', response_format: 'wav' },
  ],
  [
    'speech: stream adds stream_format',
    () => buildSpeechBody(mp3Cfg, presetResolved, 'hi', true),
    { model: 'tts', input: 'hi', voice: 'alloy', response_format: 'mp3', stream_format: 'audio' },
  ],
  [
    'speech: voice falls back to roster key when no preset field',
    () => buildSpeechBody(cfg, { name: 'placeholder', voice: { kind: 'preset' }, kind: 'preset' }, 'hi').voice,
    'placeholder',
  ],
  ['speech: no language field (library sets it)', () => has(buildSpeechBody(cfg, presetResolved, 'hi'), 'lang'), false],

  // ── buildCloneBody (clone path) ────────────────────────────────────
  [
    'clone: llama.cpp field names with transcript',
    () => buildCloneBody(cfg, cloneVoice, iclRef, 'QkFTRTY0', 'speak this'),
    {
      model: 'tts',
      input: 'speak this',
      speaker_ref_b64: 'QkFTRTY0',
      speaker_ref_text: 'upbeat line',
      lang: 'en',
      response_format: 'wav',
    },
  ],
  [
    'clone: blank transcript omits speaker_ref_text',
    () => buildCloneBody(cfg, cloneVoice, noTextRef, 'Qg==', 'hi'),
    { model: 'tts', input: 'hi', speaker_ref_b64: 'Qg==', lang: 'en', response_format: 'wav' },
  ],
  [
    'clone: unknown promptLang omits lang',
    () => has(buildCloneBody(cfg, { kind: 'clone', promptLang: 'auto' }, iclRef, 'Qg==', 'hi'), 'lang'),
    false,
  ],
  [
    'clone: stream adds stream_format',
    () => buildCloneBody(mp3Cfg, cloneVoice, iclRef, 'Qg==', 'hi', true).stream_format,
    'audio',
  ],
  [
    'clone: no legacy fields',
    () => {
      const b = buildCloneBody(cfg, cloneVoice, iclRef, 'Qg==', 'hi');
      return ['ref_audio', 'ref_text', 'x_vector_only_mode', 'language'].filter((k) => has(b, k));
    },
    [],
  ],

  // ── parseVoiceLibrary ──────────────────────────────────────────────
  [
    'library: server payload',
    () =>
      parseVoiceLibrary({
        object: 'list',
        default: 'placeholder',
        data: [{ id: 'placeholder', object: 'voice', lang: 'en', has_transcript: true, aliases: ['alloy', 'echo'] }],
      }),
    {
      default: 'placeholder',
      voices: [{ id: 'placeholder', lang: 'en', hasTranscript: true, aliases: ['alloy', 'echo'] }],
    },
  ],
  [
    'library: malformed entries dropped, aliases filtered',
    () => parseVoiceLibrary({ data: [{ id: '' }, 'x', { id: 'a', aliases: ['b', 3] }] }),
    { voices: [{ id: 'a', aliases: ['b'] }] },
  ],
  ['library: missing data -> undefined', () => parseVoiceLibrary({ detail: 'Not Found' }), undefined],
  ['library: non-object -> undefined', () => parseVoiceLibrary(null), undefined],
];

test.each(cases)('%s', (_name, got, want) => {
  expect(got()).toEqual(want);
});
