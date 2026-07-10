/**
 * Tests for lib/node/pi/tts/config.ts - config-layer coercion / merge,
 * env interpolation, base-url + auth-header resolution, voice resolution
 * (including the `clone:` prefix and per-voice endpoint overrides), and
 * emote-keyed reference selection.
 *
 * Ported from the pre-promotion hand-rolled `test-tts.ts` runner into the
 * repo's vitest convention (one `test.each` row per assertion).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  coerceConfigLayer,
  mergeConfigLayers,
  interpolateEnv,
  resolveBaseUrl,
  resolveAuthHeaders,
  resolveVoice,
  resolveVoiceBaseUrl,
  resolveVoiceAuthHeaders,
  resolveConfigPath,
  resolveLayerVoicePaths,
  loadTtsConfig,
  pickReference,
  DEFAULT_CONFIG,
} from '../../../../../lib/node/pi/tts/config.ts';
import type { TtsConfig, VoiceConfig } from '../../../../../lib/node/pi/tts/types.ts';

/** A single deep-equality case: name, lazily-evaluated actual, expected. */
type Case = [name: string, got: () => unknown, want: unknown];

const ENV = { TTS_TOKEN: 'secret123' } as unknown as NodeJS.ProcessEnv;
const cfgBase: TtsConfig = { ...DEFAULT_CONFIG, baseUrl: 'http://cfg:8880/v1/' };
const roster: TtsConfig = {
  ...DEFAULT_CONFIG,
  voices: {
    exusiai: { kind: 'clone', refAudio: '/e.wav', refText: 'hi' },
    narrator: { kind: 'preset', preset: 'ryan' },
  },
};
const epCfg: TtsConfig = {
  ...DEFAULT_CONFIG,
  baseUrl: 'http://base:8880/v1',
  authHeader: { name: 'Authorization', value: 'Bearer ${TOP_TOKEN}' },
};
const epEnv = { TOP_TOKEN: 'top', VOICE_TOKEN: 'voice' } as unknown as NodeJS.ProcessEnv;
const voiceOwnUrl: VoiceConfig = { kind: 'clone', refAudio: '/a.wav', baseUrl: 'http://voice:8881/v1/' };
const voiceNoUrl: VoiceConfig = { kind: 'preset', preset: 'Ryan' };
const voice: VoiceConfig = {
  kind: 'clone',
  refAudio: 'def.wav',
  refText: 'default line',
  emotes: [
    { match: ['excited', 'celebrate'], refAudio: 'up.wav', refText: 'upbeat' },
    { match: ['calm', 'sad'], refAudio: 'soft.wav', refText: 'soft' },
  ],
};

const cases: Case[] = [
  // ── coerceConfigLayer ──────────────────────────────────────────────
  ['coerce: non-object -> {}', () => coerceConfigLayer(null), {}],
  ['coerce: non-object string -> {}', () => coerceConfigLayer('nope'), {}],
  ['coerce: array -> {}', () => coerceConfigLayer([1, 2]), {}],
  [
    'coerce: scalars validated',
    () =>
      coerceConfigLayer({
        baseUrl: 'http://x/v1',
        api: 'openai',
        format: 'mp3',
        requestTimeoutMs: 5000,
        player: 'mpv',
      }),
    { baseUrl: 'http://x/v1', api: 'openai', format: 'mp3', requestTimeoutMs: 5000, player: 'mpv' },
  ],
  ['coerce: empty baseUrl dropped', () => coerceConfigLayer({ baseUrl: '' }), {}],
  ['coerce: bad api dropped', () => coerceConfigLayer({ api: 'xtts' }), {}],
  ['coerce: api gpt-sovits kept', () => coerceConfigLayer({ api: 'gpt-sovits' }), { api: 'gpt-sovits' }],
  ['coerce: non-positive timeout dropped', () => coerceConfigLayer({ requestTimeoutMs: 0 }), {}],
  [
    'coerce: negative chunk chars -> -1 (no-split sentinel)',
    () => coerceConfigLayer({ maxChunkChars: -5 }),
    { maxChunkChars: -1 },
  ],
  [
    'coerce: zero chunk chars kept (paragraph-only sentinel)',
    () => coerceConfigLayer({ maxChunkChars: 0 }),
    { maxChunkChars: 0 },
  ],
  ['coerce: fractional chunk chars floored', () => coerceConfigLayer({ maxChunkChars: 200.9 }), { maxChunkChars: 200 }],
  ['coerce: non-finite chunk chars dropped', () => coerceConfigLayer({ maxChunkChars: Number.NaN }), {}],
  [
    'coerce: splitSpeakerNarration true kept',
    () => coerceConfigLayer({ splitSpeakerNarration: true }),
    { splitSpeakerNarration: true },
  ],
  [
    'coerce: splitSpeakerNarration false kept',
    () => coerceConfigLayer({ splitSpeakerNarration: false }),
    { splitSpeakerNarration: false },
  ],
  ['coerce: splitSpeakerNarration non-boolean dropped', () => coerceConfigLayer({ splitSpeakerNarration: 'yes' }), {}],
  [
    'coerce: chunk + narration caps kept',
    () => coerceConfigLayer({ maxChunkChars: 200, maxNarrationChunks: 10 }),
    { maxChunkChars: 200, maxNarrationChunks: 10 },
  ],
  ['coerce: model kept', () => coerceConfigLayer({ model: 'qwen3-tts-base' }), { model: 'qwen3-tts-base' }],
  [
    'coerce: voice pointers kept',
    () => coerceConfigLayer({ rpVoice: 'exusiai', narrationVoice: 'clone:exusiai' }),
    { rpVoice: 'exusiai', narrationVoice: 'clone:exusiai' },
  ],
  ['coerce: empty rpVoice dropped', () => coerceConfigLayer({ rpVoice: '' }), {}],
  [
    'coerce: valid authHeader kept',
    () => coerceConfigLayer({ authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } }),
    { authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } },
  ],
  ['coerce: authHeader missing value dropped', () => coerceConfigLayer({ authHeader: { name: 'X' } }), {}],
  ['coerce: authHeader empty name dropped', () => coerceConfigLayer({ authHeader: { name: '', value: 'y' } }), {}],
  [
    'coerce: preset voice',
    () => coerceConfigLayer({ voices: { narrator: { kind: 'preset', preset: 'ryan', instruct: 'cheerful' } } }),
    { voices: { narrator: { kind: 'preset', preset: 'ryan', instruct: 'cheerful' } } },
  ],
  [
    'coerce: clone voice with emotes',
    () =>
      coerceConfigLayer({
        voices: {
          exusiai: {
            kind: 'clone',
            refAudio: '/a.wav',
            refText: 'hi',
            promptLang: 'en',
            emotes: [{ match: ['happy'], refAudio: '/up.wav', refText: 'yay' }],
          },
        },
      }),
    {
      voices: {
        exusiai: {
          kind: 'clone',
          refAudio: '/a.wav',
          refText: 'hi',
          promptLang: 'en',
          emotes: [{ match: ['happy'], refAudio: '/up.wav', refText: 'yay' }],
        },
      },
    },
  ],
  [
    'coerce: kind inferred clone from refAudio',
    () => coerceConfigLayer({ voices: { v: { refAudio: '/r.wav', refText: 't' } } }),
    { voices: { v: { kind: 'clone', refAudio: '/r.wav', refText: 't' } } },
  ],
  [
    'coerce: kind inferred preset when no refAudio',
    () => coerceConfigLayer({ voices: { v: { preset: 'ryan' } } }),
    { voices: { v: { kind: 'preset', preset: 'ryan' } } },
  ],
  [
    'coerce: emote missing refAudio drops bucket -> emotes undefined',
    () =>
      coerceConfigLayer({
        voices: { v: { kind: 'clone', refAudio: '/d.wav', refText: 'd', emotes: [{ match: ['x'] }] } },
      }),
    { voices: { v: { kind: 'clone', refAudio: '/d.wav', refText: 'd' } } },
  ],
  ['coerce: non-object voice dropped', () => coerceConfigLayer({ voices: { v: 'nope' } }), { voices: {} }],

  // ── mergeConfigLayers ──────────────────────────────────────────────
  ['merge: no layers -> defaults', () => mergeConfigLayers(), DEFAULT_CONFIG],
  ['merge: scalar replace, lowest-first', () => mergeConfigLayers({ format: 'wav' }, { format: 'mp3' }).format, 'mp3'],
  [
    'merge: authHeader replaced wholesale',
    () =>
      mergeConfigLayers({ authHeader: { name: 'A', value: '1' } }, { authHeader: { name: 'B', value: '2' } })
        .authHeader,
    { name: 'B', value: '2' },
  ],
  [
    'merge: voices merge by key (add)',
    () =>
      Object.keys(
        mergeConfigLayers({ voices: { a: { kind: 'preset' } } }, { voices: { b: { kind: 'preset' } } }).voices,
      ).sort(),
    ['a', 'b'],
  ],
  [
    'merge: voices replace one by name, keep others',
    () =>
      mergeConfigLayers(
        { voices: { a: { kind: 'preset', preset: 'old' }, b: { kind: 'preset' } } },
        { voices: { a: { kind: 'preset', preset: 'new' } } },
      ).voices.a.preset,
    'new',
  ],
  [
    'merge: voice pointers carry through',
    () => mergeConfigLayers({ rpVoice: 'exusiai' }, { narrationVoice: 'narrator' }),
    { ...DEFAULT_CONFIG, rpVoice: 'exusiai', narrationVoice: 'narrator' },
  ],

  // ── interpolateEnv ─────────────────────────────────────────────────
  ['interpolate: substitutes', () => interpolateEnv('Bearer ${TTS_TOKEN}', ENV), 'Bearer secret123'],
  ['interpolate: missing -> empty', () => interpolateEnv('x=${NOPE}', ENV), 'x='],
  ['interpolate: no markers', () => interpolateEnv('http://127.0.0.1:8880/v1', ENV), 'http://127.0.0.1:8880/v1'],

  // ── resolveBaseUrl ─────────────────────────────────────────────────
  ['resolveBaseUrl: config wins, trailing slash stripped', () => resolveBaseUrl(cfgBase, {}), 'http://cfg:8880/v1'],
  [
    'resolveBaseUrl: PI_TTS_URL overrides',
    () => resolveBaseUrl(cfgBase, { PI_TTS_URL: 'http://env:9000/v1/' }),
    'http://env:9000/v1',
  ],
  [
    'resolveBaseUrl: ${ENV} interpolated',
    () =>
      resolveBaseUrl(
        { ...DEFAULT_CONFIG, baseUrl: 'http://${TTS_HOST}/v1' },
        {
          TTS_HOST: 'h:1',
        },
      ),
    'http://h:1/v1',
  ],

  // ── resolveAuthHeaders ─────────────────────────────────────────────
  ['resolveAuthHeaders: none -> {}', () => resolveAuthHeaders(DEFAULT_CONFIG, {}), {}],
  [
    'resolveAuthHeaders: interpolated',
    () =>
      resolveAuthHeaders(
        { ...DEFAULT_CONFIG, authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } },
        ENV,
      ),
    { Authorization: 'Bearer secret123' },
  ],
  [
    'resolveAuthHeaders: unset token -> empty value dropped',
    () => resolveAuthHeaders({ ...DEFAULT_CONFIG, authHeader: { name: 'Authorization', value: '${NOPE}' } }, {}),
    {},
  ],

  // ── resolveVoice (clone: prefix) ───────────────────────────────────
  [
    'resolveVoice: bare clone uses declared kind',
    () => resolveVoice(roster, 'exusiai'),
    { name: 'exusiai', voice: { kind: 'clone', refAudio: '/e.wav', refText: 'hi' }, kind: 'clone' },
  ],
  ['resolveVoice: bare preset uses declared kind', () => resolveVoice(roster, 'narrator')?.kind, 'preset'],
  ['resolveVoice: clone: prefix forces clone on a preset', () => resolveVoice(roster, 'clone:narrator')?.kind, 'clone'],
  ['resolveVoice: clone: prefix strips to name', () => resolveVoice(roster, 'clone:narrator')?.name, 'narrator'],
  ['resolveVoice: case-insensitive key -> canonical name', () => resolveVoice(roster, 'EXUSIAI')?.name, 'exusiai'],
  ['resolveVoice: mixed-case clone: prefix forces clone', () => resolveVoice(roster, 'Clone:Narrator')?.kind, 'clone'],
  [
    'resolveVoice: case-insensitive returns canonical name from clone alias',
    () => resolveVoice(roster, 'clone:EXUSIAI')?.name,
    'exusiai',
  ],
  ['resolveVoice: unknown name -> undefined', () => resolveVoice(roster, 'nobody'), undefined],
  ['resolveVoice: empty pointer -> undefined', () => resolveVoice(roster, ''), undefined],
  ['resolveVoice: undefined pointer -> undefined', () => resolveVoice(roster, undefined), undefined],
  ['resolveVoice: clone: with empty name -> undefined', () => resolveVoice(roster, 'clone:'), undefined],

  // ── per-voice endpoint resolution (baseUrl + authHeader override) ───
  [
    'voice url: own baseUrl wins (slash stripped)',
    () => resolveVoiceBaseUrl(epCfg, voiceOwnUrl, epEnv),
    'http://voice:8881/v1',
  ],
  ['voice url: falls back to top-level', () => resolveVoiceBaseUrl(epCfg, voiceNoUrl, epEnv), 'http://base:8880/v1'],
  [
    'voice url: undefined voice -> top-level',
    () => resolveVoiceBaseUrl(epCfg, undefined, epEnv),
    'http://base:8880/v1',
  ],
  [
    'voice url: PI_TTS_URL overrides only the fallback, NOT a voice url',
    () =>
      resolveVoiceBaseUrl(epCfg, voiceOwnUrl, {
        ...epEnv,
        PI_TTS_URL: 'http://env:9999/v1',
      }),
    'http://voice:8881/v1',
  ],
  [
    'voice url: PI_TTS_URL overrides the fallback when voice has none',
    () =>
      resolveVoiceBaseUrl(epCfg, voiceNoUrl, {
        ...epEnv,
        PI_TTS_URL: 'http://env:9999/v1',
      }),
    'http://env:9999/v1',
  ],
  [
    'voice auth: own header wins (interpolated)',
    () =>
      resolveVoiceAuthHeaders(
        { ...epCfg },
        { kind: 'clone', authHeader: { name: 'X-Key', value: '${VOICE_TOKEN}' } },
        epEnv,
      ),
    { 'X-Key': 'voice' },
  ],
  [
    'voice auth: falls back to top-level header',
    () => resolveVoiceAuthHeaders(epCfg, voiceNoUrl, epEnv),
    { Authorization: 'Bearer top' },
  ],
  ['voice auth: no header anywhere -> {}', () => resolveVoiceAuthHeaders({ ...DEFAULT_CONFIG }, voiceNoUrl, epEnv), {}],
  [
    'coerce: per-voice baseUrl + authHeader kept',
    () =>
      coerceConfigLayer({
        voices: {
          v: { kind: 'clone', refAudio: '/r.wav', baseUrl: 'http://x/v1', authHeader: { name: 'A', value: 'b' } },
        },
      }).voices?.v,
    { kind: 'clone', refAudio: '/r.wav', baseUrl: 'http://x/v1', authHeader: { name: 'A', value: 'b' } },
  ],

  // ── pickReference ──────────────────────────────────────────────────
  ['pickRef: excited -> upbeat', () => pickReference(voice, 'excited'), { refAudio: 'up.wav', refText: 'upbeat' }],
  [
    'pickRef: CALM case-insensitive -> soft',
    () => pickReference(voice, 'CALM'),
    { refAudio: 'soft.wav', refText: 'soft' },
  ],
  [
    'pickRef: unknown emote -> default',
    () => pickReference(voice, 'bewildered'),
    { refAudio: 'def.wav', refText: 'default line' },
  ],
  [
    'pickRef: no emote -> default',
    () => pickReference(voice, undefined),
    { refAudio: 'def.wav', refText: 'default line' },
  ],
  [
    'pickRef: no emotes config -> default',
    () => pickReference({ kind: 'clone', refAudio: 'a.wav', refText: 'b' }, 'excited'),
    { refAudio: 'a.wav', refText: 'b' },
  ],
  [
    'pickRef: no default clip -> undefined',
    () => pickReference({ kind: 'preset', preset: 'ryan' }, undefined),
    undefined,
  ],
  [
    'pickRef: refText absent -> empty string',
    () => pickReference({ kind: 'clone', refAudio: 'a.wav' }, undefined),
    { refAudio: 'a.wav', refText: '' },
  ],
];

test.each(cases)('%s', (_name, got, want) => {
  expect(got()).toEqual(want);
});

test('merge: DEFAULT_CONFIG.voices not mutated by a merge', () => {
  mergeConfigLayers({ voices: { x: { kind: 'preset' } } });
  expect(DEFAULT_CONFIG.voices).toEqual({});
});

// ── refAudio path resolution ─────────────────────────────────────────
const HOME = '/home/tester';
const BASE = '/proj/.pi';

test('resolveConfigPath: absolute path passes through untouched', () => {
  expect(resolveConfigPath('/abs/clip.wav', BASE, HOME)).toBe('/abs/clip.wav');
});
test('resolveConfigPath: bare relative resolves against baseDir', () => {
  expect(resolveConfigPath('clips/clip.wav', BASE, HOME)).toBe('/proj/.pi/clips/clip.wav');
});
test('resolveConfigPath: dot-relative resolves against baseDir', () => {
  expect(resolveConfigPath('./a.wav', BASE, HOME)).toBe('/proj/.pi/a.wav');
  expect(resolveConfigPath('../shared/a.wav', BASE, HOME)).toBe('/proj/shared/a.wav');
});
test('resolveConfigPath: ~ expands to home, ~/ joins under home', () => {
  expect(resolveConfigPath('~', BASE, HOME)).toBe('/home/tester');
  expect(resolveConfigPath('~/voices/a.wav', BASE, HOME)).toBe('/home/tester/voices/a.wav');
});

test('resolveLayerVoicePaths: resolves voice + emote refAudio, leaves absolute', () => {
  const layer: Partial<TtsConfig> = {
    voices: {
      rel: {
        kind: 'clone',
        refAudio: 'clips/rel.wav',
        refText: 'hi',
        emotes: [{ match: ['up'], refAudio: 'em/up.wav', refText: 'y' }],
      },
      abs: { kind: 'clone', refAudio: '/abs/a.wav' },
      preset: { kind: 'preset', preset: 'ryan' },
    },
  };
  const out = resolveLayerVoicePaths(layer, BASE, HOME);
  expect(out.voices?.rel.refAudio).toBe('/proj/.pi/clips/rel.wav');
  expect(out.voices?.rel.emotes?.[0].refAudio).toBe('/proj/.pi/em/up.wav');
  expect(out.voices?.abs.refAudio).toBe('/abs/a.wav');
  expect(out.voices?.preset.refAudio).toBeUndefined();
});
test('resolveLayerVoicePaths: layer without voices passes through unchanged', () => {
  const layer: Partial<TtsConfig> = { baseUrl: 'http://x/v1' };
  expect(resolveLayerVoicePaths(layer, BASE, HOME)).toEqual(layer);
});
test('resolveLayerVoicePaths: does not mutate the input layer', () => {
  const layer: Partial<TtsConfig> = { voices: { v: { kind: 'clone', refAudio: 'a.wav' } } };
  resolveLayerVoicePaths(layer, BASE, HOME);
  expect(layer.voices?.v.refAudio).toBe('a.wav');
});

// ──────────────────────────────────────────────────────────────────────
// loadTtsConfig: disk layering + per-layer refAudio base directory.
// The project layer resolves relative paths against the project root (`cwd`),
// NOT `<cwd>/.pi/`, so a clip written relative to where the user works lands
// as expected; the user (global) layer resolves against its own directory.
// ──────────────────────────────────────────────────────────────────────
let tmp: string;
let prevAgentDir: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tts-load-'));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmp, 'agent');
  mkdirSync(join(tmp, 'agent'), { recursive: true });
});
afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(tmp, { recursive: true, force: true });
});

test('loadTtsConfig: project-layer relative refAudio resolves against the project root', () => {
  const cwd = join(tmp, 'proj');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'tts.json'),
    JSON.stringify({
      api: 'openai',
      voices: { v: { kind: 'clone', refAudio: 'dev/tts/clip.wav', refText: 'x' } },
      rpVoice: 'v',
    }),
  );
  const cfg = loadTtsConfig(cwd, true);
  expect(cfg.voices?.v.refAudio).toBe(join(cwd, 'dev/tts/clip.wav'));
});

test('loadTtsConfig: user-layer relative refAudio resolves against the agent dir', () => {
  const agentDir = join(tmp, 'agent');
  writeFileSync(
    join(agentDir, 'tts.json'),
    JSON.stringify({
      api: 'openai',
      voices: { g: { kind: 'clone', refAudio: 'voices/clip.wav', refText: 'x' } },
      rpVoice: 'g',
    }),
  );
  const cfg = loadTtsConfig(join(tmp, 'proj'), false);
  expect(cfg.voices?.g.refAudio).toBe(join(agentDir, 'voices/clip.wav'));
});

test('loadTtsConfig: gpt-sovits leaves relative refAudio unresolved (server-side)', () => {
  const cwd = join(tmp, 'proj');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'tts.json'),
    JSON.stringify({
      api: 'gpt-sovits',
      voices: { v: { kind: 'clone', refAudio: 'dev/tts/clip.wav', refText: 'x' } },
      rpVoice: 'v',
    }),
  );
  const cfg = loadTtsConfig(cwd, true);
  expect(cfg.voices?.v.refAudio).toBe('dev/tts/clip.wav');
});
