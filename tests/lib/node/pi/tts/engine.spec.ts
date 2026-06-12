/**
 * Tests for lib/node/pi/tts/engine.ts - pure request-body builders and the
 * language-code normalization. Network synth (`synthesize`, the probes,
 * `setGptSovitsWeights`) is intentionally not exercised here.
 *
 * Ported from the pre-promotion hand-rolled `test-tts.ts` runner into the
 * repo's vitest convention (one `test.each` row per assertion).
 */

import { expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../../../../../lib/node/pi/tts/config.ts';
import { languageForServer, buildSpeechBody, buildCloneBody } from '../../../../../lib/node/pi/tts/engine.ts';
import type { Reference, ResolvedVoice, TtsConfig, VoiceConfig } from '../../../../../lib/node/pi/tts/types.ts';

/** A single deep-equality case: name, lazily-evaluated actual, expected. */
type Case = [name: string, got: () => unknown, want: unknown];

const speechCfg: TtsConfig = { ...DEFAULT_CONFIG, model: 'qwen3-tts', format: 'wav' };
const presetResolved: ResolvedVoice = {
  name: 'narrator',
  voice: { kind: 'preset', preset: 'ryan', instruct: 'calm and warm', promptLang: 'en' },
  kind: 'preset',
};

const cloneCfg: TtsConfig = { ...DEFAULT_CONFIG, format: 'wav' };
const cloneVoice: VoiceConfig = { kind: 'clone', refAudio: '/d.wav', refText: 'default', promptLang: 'en' };
const iclRef: Reference = { refAudio: '/up.wav', refText: 'upbeat line' };
const noTextRef: Reference = { refAudio: '/x.wav', refText: '   ' };
const noText = buildCloneBody(cloneCfg, cloneVoice, noTextRef, 'Qg==', 'hi');

const cases: Case[] = [
  // ── languageForServer ──────────────────────────────────────────────
  ['lang: undefined -> Auto', () => languageForServer(undefined), 'Auto'],
  ['lang: empty -> Auto', () => languageForServer('  '), 'Auto'],
  ['lang: code en -> English', () => languageForServer('en'), 'English'],
  ['lang: code JA case-insensitive -> Japanese', () => languageForServer('JA'), 'Japanese'],
  ['lang: name English passes through', () => languageForServer('English'), 'English'],
  ['lang: explicit Auto -> Auto', () => languageForServer('auto'), 'Auto'],
  ['lang: unknown -> Auto', () => languageForServer('klingon'), 'Auto'],

  // ── buildSpeechBody (preset path) ──────────────────────────────────
  [
    'speech: full body',
    () => buildSpeechBody(speechCfg, presetResolved, 'hello there'),
    {
      model: 'qwen3-tts',
      input: 'hello there',
      voice: 'ryan',
      response_format: 'wav',
      language: 'English',
      instruct: 'calm and warm',
    },
  ],
  [
    'speech: voice falls back to roster key when no preset field',
    () => buildSpeechBody(speechCfg, { name: 'Vivian', voice: { kind: 'preset' }, kind: 'preset' }, 'hi').voice,
    'Vivian',
  ],
  [
    'speech: instruct omitted when unset',
    () =>
      Object.prototype.hasOwnProperty.call(
        buildSpeechBody(speechCfg, { name: 'v', voice: { kind: 'preset', preset: 'v' }, kind: 'preset' }, 'hi'),
        'instruct',
      ),
    false,
  ],
  [
    'speech: no promptLang -> Auto',
    () =>
      buildSpeechBody(speechCfg, { name: 'v', voice: { kind: 'preset', preset: 'v' }, kind: 'preset' }, 'hi').language,
    'Auto',
  ],

  // ── buildCloneBody (clone path) ────────────────────────────────────
  [
    'clone: ICL mode when ref_text present',
    () => buildCloneBody(cloneCfg, cloneVoice, iclRef, 'QkFTRTY0', 'speak this'),
    {
      input: 'speak this',
      ref_audio: 'QkFTRTY0',
      x_vector_only_mode: false,
      language: 'English',
      response_format: 'wav',
      ref_text: 'upbeat line',
    },
  ],
  ['clone: x-vector mode when ref_text blank', () => noText.x_vector_only_mode, true],
  ['clone: ref_text omitted when blank', () => Object.prototype.hasOwnProperty.call(noText, 'ref_text'), false],
];

test.each(cases)('%s', (_name, got, want) => {
  expect(got()).toEqual(want);
});
