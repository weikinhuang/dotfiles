// Deterministic tests for the tts extension's pure config + text helpers.
// No audio, no network, no disk reads of real config.
// Run: node lib/node/pi/tts/test-tts.ts

import {
  coerceConfigLayer,
  mergeConfigLayers,
  interpolateEnv,
  resolveBaseUrl,
  resolveAuthHeaders,
  resolveVoice,
  resolveVoiceBaseUrl,
  resolveVoiceAuthHeaders,
  pickReference,
  DEFAULT_CONFIG,
} from './config.ts';
import { extractDialogue, detectOoc, extractProse, chunkProse, extractSegments, planSegmentRuns } from './text.ts';
import { languageForServer, buildSpeechBody, buildCloneBody } from './engine.ts';
import type { Reference, ResolvedVoice, TtsConfig, VoiceConfig } from './types.ts';

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

// ── coerceConfigLayer ───────────────────────────────────────────────
eq('coerce: non-object -> {}', coerceConfigLayer(null), {});
eq('coerce: non-object string -> {}', coerceConfigLayer('nope'), {});
eq('coerce: array -> {}', coerceConfigLayer([1, 2]), {});
eq(
  'coerce: scalars validated',
  coerceConfigLayer({ baseUrl: 'http://x/v1', api: 'openai', format: 'mp3', requestTimeoutMs: 5000, player: 'mpv' }),
  { baseUrl: 'http://x/v1', api: 'openai', format: 'mp3', requestTimeoutMs: 5000, player: 'mpv' },
);
eq('coerce: empty baseUrl dropped', coerceConfigLayer({ baseUrl: '' }), {});
eq('coerce: bad api dropped', coerceConfigLayer({ api: 'xtts' }), {});
eq('coerce: api gpt-sovits kept', coerceConfigLayer({ api: 'gpt-sovits' }), { api: 'gpt-sovits' });
eq('coerce: non-positive timeout dropped', coerceConfigLayer({ requestTimeoutMs: 0 }), {});
eq('coerce: negative chunk chars dropped', coerceConfigLayer({ maxChunkChars: -5 }), {});
eq('coerce: chunk + narration caps kept', coerceConfigLayer({ maxChunkChars: 200, maxNarrationChunks: 10 }), {
  maxChunkChars: 200,
  maxNarrationChunks: 10,
});
eq('coerce: model kept', coerceConfigLayer({ model: 'qwen3-tts-base' }), { model: 'qwen3-tts-base' });
eq('coerce: voice pointers kept', coerceConfigLayer({ rpVoice: 'exusiai', narrationVoice: 'clone:exusiai' }), {
  rpVoice: 'exusiai',
  narrationVoice: 'clone:exusiai',
});
eq('coerce: empty rpVoice dropped', coerceConfigLayer({ rpVoice: '' }), {});

// authHeader
eq(
  'coerce: valid authHeader kept',
  coerceConfigLayer({ authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } }),
  { authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } },
);
eq('coerce: authHeader missing value dropped', coerceConfigLayer({ authHeader: { name: 'X' } }), {});
eq('coerce: authHeader empty name dropped', coerceConfigLayer({ authHeader: { name: '', value: 'y' } }), {});

// voices: preset
eq(
  'coerce: preset voice',
  coerceConfigLayer({ voices: { narrator: { kind: 'preset', preset: 'ryan', instruct: 'cheerful' } } }),
  { voices: { narrator: { kind: 'preset', preset: 'ryan', instruct: 'cheerful' } } },
);
// voices: clone with emotes
eq(
  'coerce: clone voice with emotes',
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
);
// voices: kind inferred from refAudio
eq(
  'coerce: kind inferred clone from refAudio',
  coerceConfigLayer({ voices: { v: { refAudio: '/r.wav', refText: 't' } } }),
  { voices: { v: { kind: 'clone', refAudio: '/r.wav', refText: 't' } } },
);
eq('coerce: kind inferred preset when no refAudio', coerceConfigLayer({ voices: { v: { preset: 'ryan' } } }), {
  voices: { v: { kind: 'preset', preset: 'ryan' } },
});
// voices: malformed emote bucket dropped
eq(
  'coerce: emote missing refAudio drops bucket -> emotes undefined',
  coerceConfigLayer({ voices: { v: { kind: 'clone', refAudio: '/d.wav', refText: 'd', emotes: [{ match: ['x'] }] } } }),
  { voices: { v: { kind: 'clone', refAudio: '/d.wav', refText: 'd' } } },
);
// voices: non-object voice dropped
eq('coerce: non-object voice dropped', coerceConfigLayer({ voices: { v: 'nope' } }), { voices: {} });

// ── mergeConfigLayers ───────────────────────────────────────────────
eq('merge: no layers -> defaults', mergeConfigLayers(), DEFAULT_CONFIG);
eq('merge: scalar replace, lowest-first', mergeConfigLayers({ format: 'wav' }, { format: 'mp3' }).format, 'mp3');
eq(
  'merge: authHeader replaced wholesale',
  mergeConfigLayers({ authHeader: { name: 'A', value: '1' } }, { authHeader: { name: 'B', value: '2' } }).authHeader,
  { name: 'B', value: '2' },
);
eq(
  'merge: voices merge by key (add)',
  Object.keys(
    mergeConfigLayers({ voices: { a: { kind: 'preset' } } }, { voices: { b: { kind: 'preset' } } }).voices,
  ).sort(),
  ['a', 'b'],
);
eq(
  'merge: voices replace one by name, keep others',
  mergeConfigLayers(
    { voices: { a: { kind: 'preset', preset: 'old' }, b: { kind: 'preset' } } },
    { voices: { a: { kind: 'preset', preset: 'new' } } },
  ).voices.a.preset,
  'new',
);
eq('merge: voice pointers carry through', mergeConfigLayers({ rpVoice: 'exusiai' }, { narrationVoice: 'narrator' }), {
  ...DEFAULT_CONFIG,
  rpVoice: 'exusiai',
  narrationVoice: 'narrator',
});
// default config is not mutated by a merge
mergeConfigLayers({ voices: { x: { kind: 'preset' } } });
eq('merge: DEFAULT_CONFIG.voices not mutated', DEFAULT_CONFIG.voices, {});

// ── interpolateEnv ──────────────────────────────────────────────────
const ENV = { TTS_TOKEN: 'secret123' } as unknown as NodeJS.ProcessEnv;
eq('interpolate: substitutes', interpolateEnv('Bearer ${TTS_TOKEN}', ENV), 'Bearer secret123');
eq('interpolate: missing -> empty', interpolateEnv('x=${NOPE}', ENV), 'x=');
eq('interpolate: no markers', interpolateEnv('http://127.0.0.1:8880/v1', ENV), 'http://127.0.0.1:8880/v1');

// ── resolveBaseUrl ──────────────────────────────────────────────────
const cfgBase: TtsConfig = { ...DEFAULT_CONFIG, baseUrl: 'http://cfg:8880/v1/' };
eq(
  'resolveBaseUrl: config wins, trailing slash stripped',
  resolveBaseUrl(cfgBase, {} as NodeJS.ProcessEnv),
  'http://cfg:8880/v1',
);
eq(
  'resolveBaseUrl: PI_TTS_URL overrides',
  resolveBaseUrl(cfgBase, { PI_TTS_URL: 'http://env:9000/v1/' } as unknown as NodeJS.ProcessEnv),
  'http://env:9000/v1',
);
eq(
  'resolveBaseUrl: ${ENV} interpolated',
  resolveBaseUrl({ ...DEFAULT_CONFIG, baseUrl: 'http://${TTS_HOST}/v1' }, {
    TTS_HOST: 'h:1',
  } as unknown as NodeJS.ProcessEnv),
  'http://h:1/v1',
);

// ── resolveAuthHeaders ──────────────────────────────────────────────
eq('resolveAuthHeaders: none -> {}', resolveAuthHeaders(DEFAULT_CONFIG, {} as NodeJS.ProcessEnv), {});
eq(
  'resolveAuthHeaders: interpolated',
  resolveAuthHeaders({ ...DEFAULT_CONFIG, authHeader: { name: 'Authorization', value: 'Bearer ${TTS_TOKEN}' } }, ENV),
  { Authorization: 'Bearer secret123' },
);
eq(
  'resolveAuthHeaders: unset token -> empty value dropped',
  resolveAuthHeaders(
    { ...DEFAULT_CONFIG, authHeader: { name: 'Authorization', value: '${NOPE}' } },
    {} as NodeJS.ProcessEnv,
  ),
  {},
);

// ── resolveVoice (clone: prefix) ────────────────────────────────────
const roster: TtsConfig = {
  ...DEFAULT_CONFIG,
  voices: {
    exusiai: { kind: 'clone', refAudio: '/e.wav', refText: 'hi' },
    narrator: { kind: 'preset', preset: 'ryan' },
  },
};
eq('resolveVoice: bare clone uses declared kind', resolveVoice(roster, 'exusiai'), {
  name: 'exusiai',
  voice: { kind: 'clone', refAudio: '/e.wav', refText: 'hi' },
  kind: 'clone',
});
eq('resolveVoice: bare preset uses declared kind', resolveVoice(roster, 'narrator')?.kind, 'preset');
eq('resolveVoice: clone: prefix forces clone on a preset', resolveVoice(roster, 'clone:narrator')?.kind, 'clone');
eq('resolveVoice: clone: prefix strips to name', resolveVoice(roster, 'clone:narrator')?.name, 'narrator');
eq('resolveVoice: case-insensitive key -> canonical name', resolveVoice(roster, 'EXUSIAI')?.name, 'exusiai');
eq('resolveVoice: mixed-case clone: prefix forces clone', resolveVoice(roster, 'Clone:Narrator')?.kind, 'clone');
eq(
  'resolveVoice: case-insensitive returns canonical name from clone alias',
  resolveVoice(roster, 'clone:EXUSIAI')?.name,
  'exusiai',
);
eq('resolveVoice: unknown name -> undefined', resolveVoice(roster, 'nobody'), undefined);
eq('resolveVoice: empty pointer -> undefined', resolveVoice(roster, ''), undefined);
eq('resolveVoice: undefined pointer -> undefined', resolveVoice(roster, undefined), undefined);
eq('resolveVoice: clone: with empty name -> undefined', resolveVoice(roster, 'clone:'), undefined);

// ── per-voice endpoint resolution (baseUrl + authHeader override) ────
const epCfg: TtsConfig = {
  ...DEFAULT_CONFIG,
  baseUrl: 'http://base:8880/v1',
  authHeader: { name: 'Authorization', value: 'Bearer ${TOP_TOKEN}' },
};
const epEnv = { TOP_TOKEN: 'top', VOICE_TOKEN: 'voice' } as unknown as NodeJS.ProcessEnv;
const voiceOwnUrl: VoiceConfig = { kind: 'clone', refAudio: '/a.wav', baseUrl: 'http://voice:8881/v1/' };
const voiceNoUrl: VoiceConfig = { kind: 'preset', preset: 'Ryan' };
eq(
  'voice url: own baseUrl wins (slash stripped)',
  resolveVoiceBaseUrl(epCfg, voiceOwnUrl, epEnv),
  'http://voice:8881/v1',
);
eq('voice url: falls back to top-level', resolveVoiceBaseUrl(epCfg, voiceNoUrl, epEnv), 'http://base:8880/v1');
eq('voice url: undefined voice -> top-level', resolveVoiceBaseUrl(epCfg, undefined, epEnv), 'http://base:8880/v1');
eq(
  'voice url: PI_TTS_URL overrides only the fallback, NOT a voice url',
  resolveVoiceBaseUrl(epCfg, voiceOwnUrl, {
    ...epEnv,
    PI_TTS_URL: 'http://env:9999/v1',
  } as unknown as NodeJS.ProcessEnv),
  'http://voice:8881/v1',
);
eq(
  'voice url: PI_TTS_URL overrides the fallback when voice has none',
  resolveVoiceBaseUrl(epCfg, voiceNoUrl, {
    ...epEnv,
    PI_TTS_URL: 'http://env:9999/v1',
  } as unknown as NodeJS.ProcessEnv),
  'http://env:9999/v1',
);
eq(
  'voice auth: own header wins (interpolated)',
  resolveVoiceAuthHeaders(
    { ...epCfg },
    { kind: 'clone', authHeader: { name: 'X-Key', value: '${VOICE_TOKEN}' } },
    epEnv,
  ),
  { 'X-Key': 'voice' },
);
eq('voice auth: falls back to top-level header', resolveVoiceAuthHeaders(epCfg, voiceNoUrl, epEnv), {
  Authorization: 'Bearer top',
});
eq('voice auth: no header anywhere -> {}', resolveVoiceAuthHeaders({ ...DEFAULT_CONFIG }, voiceNoUrl, epEnv), {});
eq(
  'coerce: per-voice baseUrl + authHeader kept',
  coerceConfigLayer({
    voices: { v: { kind: 'clone', refAudio: '/r.wav', baseUrl: 'http://x/v1', authHeader: { name: 'A', value: 'b' } } },
  }).voices?.v,
  { kind: 'clone', refAudio: '/r.wav', baseUrl: 'http://x/v1', authHeader: { name: 'A', value: 'b' } },
);

// ── pickReference ───────────────────────────────────────────────────
const voice: VoiceConfig = {
  kind: 'clone',
  refAudio: 'def.wav',
  refText: 'default line',
  emotes: [
    { match: ['excited', 'celebrate'], refAudio: 'up.wav', refText: 'upbeat' },
    { match: ['calm', 'sad'], refAudio: 'soft.wav', refText: 'soft' },
  ],
};
eq('pickRef: excited -> upbeat', pickReference(voice, 'excited'), { refAudio: 'up.wav', refText: 'upbeat' });
eq('pickRef: CALM case-insensitive -> soft', pickReference(voice, 'CALM'), { refAudio: 'soft.wav', refText: 'soft' });
eq('pickRef: unknown emote -> default', pickReference(voice, 'bewildered'), {
  refAudio: 'def.wav',
  refText: 'default line',
});
eq('pickRef: no emote -> default', pickReference(voice, undefined), { refAudio: 'def.wav', refText: 'default line' });
eq(
  'pickRef: no emotes config -> default',
  pickReference({ kind: 'clone', refAudio: 'a.wav', refText: 'b' }, 'excited'),
  { refAudio: 'a.wav', refText: 'b' },
);
eq('pickRef: no default clip -> undefined', pickReference({ kind: 'preset', preset: 'ryan' }, undefined), undefined);
eq('pickRef: refText absent -> empty string', pickReference({ kind: 'clone', refAudio: 'a.wav' }, undefined), {
  refAudio: 'a.wav',
  refText: '',
});

// ── extractDialogue (carried from rp-tts) ───────────────────────────
eq(
  'dialogue: straight quotes, drop action prose',
  extractDialogue('*She grins and waves.* "Hey leader, got some work for us?" *She winks.*'),
  'Hey leader, got some work for us?',
);
eq('dialogue: smart curly quotes', extractDialogue('\u201cTargets locked.\u201d she said.'), 'Targets locked.');
eq('dialogue: multiple spans concatenated', extractDialogue('"First." *beat* "Second."'), 'First. Second.');
eq(
  'dialogue: contraction apostrophe does not break the span',
  extractDialogue(`"It's late, you should rest, don't you think?"`),
  `It's late, you should rest, don't you think?`,
);
eq('dialogue: no dialogue -> empty', extractDialogue('*She just stares, saying nothing.*'), '');
eq('dialogue: empty input -> empty', extractDialogue(''), '');
eq('dialogue: OOC block excluded', extractDialogue('"Real line." [OOC: "this is meta"]'), 'Real line.');
eq('dialogue: fenced code excluded', extractDialogue('"Speak this." ```js\nconst x = "not this";\n```'), 'Speak this.');
eq(
  'dialogue: emote + color tags stripped, inner text kept',
  extractDialogue('[emote:happy] [c:red]"Hello there!"[/c]'),
  'Hello there!',
);
eq(
  'dialogue: literal generate_image call excluded',
  extractDialogue('"Say cheese!" generate_image(prompt="1girl, smiling", negative="bad")'),
  'Say cheese!',
);

// ── detectOoc ───────────────────────────────────────────────────────
eq('ooc: detect pause', detectOoc('text [OOC: PAUSE] more'), 'pause');
eq('ooc: detect resume', detectOoc('[OOC: RESUME now]'), 'resume');
eq('ooc: resume wins when both', detectOoc('[OOC: PAUSE] [OOC: RESUME]'), 'resume');
eq('ooc: none -> null', detectOoc('just a normal line'), null);

// ── languageForServer ───────────────────────────────────────────────
eq('lang: undefined -> Auto', languageForServer(undefined), 'Auto');
eq('lang: empty -> Auto', languageForServer('  '), 'Auto');
eq('lang: code en -> English', languageForServer('en'), 'English');
eq('lang: code JA case-insensitive -> Japanese', languageForServer('JA'), 'Japanese');
eq('lang: name English passes through', languageForServer('English'), 'English');
eq('lang: explicit Auto -> Auto', languageForServer('auto'), 'Auto');
eq('lang: unknown -> Auto', languageForServer('klingon'), 'Auto');

// ── buildSpeechBody (preset path) ───────────────────────────────────
const speechCfg: TtsConfig = { ...DEFAULT_CONFIG, model: 'qwen3-tts', format: 'wav' };
const presetResolved: ResolvedVoice = {
  name: 'narrator',
  voice: { kind: 'preset', preset: 'ryan', instruct: 'calm and warm', promptLang: 'en' },
  kind: 'preset',
};
eq('speech: full body', buildSpeechBody(speechCfg, presetResolved, 'hello there'), {
  model: 'qwen3-tts',
  input: 'hello there',
  voice: 'ryan',
  response_format: 'wav',
  language: 'English',
  instruct: 'calm and warm',
});
eq(
  'speech: voice falls back to roster key when no preset field',
  buildSpeechBody(speechCfg, { name: 'Vivian', voice: { kind: 'preset' }, kind: 'preset' }, 'hi').voice,
  'Vivian',
);
eq(
  'speech: instruct omitted when unset',
  Object.prototype.hasOwnProperty.call(
    buildSpeechBody(speechCfg, { name: 'v', voice: { kind: 'preset', preset: 'v' }, kind: 'preset' }, 'hi'),
    'instruct',
  ),
  false,
);
eq(
  'speech: no promptLang -> Auto',
  buildSpeechBody(speechCfg, { name: 'v', voice: { kind: 'preset', preset: 'v' }, kind: 'preset' }, 'hi').language,
  'Auto',
);

// ── buildCloneBody (clone path) ─────────────────────────────────────
const cloneCfg: TtsConfig = { ...DEFAULT_CONFIG, format: 'wav' };
const cloneVoice: VoiceConfig = { kind: 'clone', refAudio: '/d.wav', refText: 'default', promptLang: 'en' };
const iclRef: Reference = { refAudio: '/up.wav', refText: 'upbeat line' };
eq('clone: ICL mode when ref_text present', buildCloneBody(cloneCfg, cloneVoice, iclRef, 'QkFTRTY0', 'speak this'), {
  input: 'speak this',
  ref_audio: 'QkFTRTY0',
  x_vector_only_mode: false,
  language: 'English',
  response_format: 'wav',
  ref_text: 'upbeat line',
});
const noTextRef: Reference = { refAudio: '/x.wav', refText: '   ' };
const noText = buildCloneBody(cloneCfg, cloneVoice, noTextRef, 'Qg==', 'hi');
eq('clone: x-vector mode when ref_text blank', noText.x_vector_only_mode, true);
eq('clone: ref_text omitted when blank', Object.prototype.hasOwnProperty.call(noText, 'ref_text'), false);

// ── extractProse (narration) ────────────────────────────────────────
eq('prose: empty -> empty', extractProse(''), '');
eq('prose: plain text passes', extractProse('Hello there, friend.'), 'Hello there, friend.');
eq(
  'prose: fenced code removed',
  extractProse('Here is the fix:\n```js\nconst x = 1;\n```\nThat should work.'),
  'Here is the fix: That should work.',
);
eq(
  'prose: inline code keeps token, drops backticks',
  extractProse('Call the `foo` function now.'),
  'Call the foo function now.',
);
eq(
  'prose: markdown link keeps text, drops url',
  extractProse('See [the docs](https://example.com/page) for more.'),
  'See the docs for more.',
);
eq('prose: bare url removed', extractProse('Go to https://example.com now.'), 'Go to now.');
eq(
  'prose: emphasis markers stripped',
  extractProse('This is **very** _important_ and ~~old~~ stuff.'),
  'This is very important and old stuff.',
);
eq(
  'prose: heading + bullets flattened',
  extractProse('# Title\n\n- first point\n- second point'),
  'Title first point second point',
);
eq('prose: ordered list markers flattened', extractProse('1. do this\n2. then that'), 'do this then that');
eq('prose: blockquote marker dropped', extractProse('> a quoted line'), 'a quoted line');
eq(
  'prose: generate_image call removed',
  extractProse('Let me draw it. generate_image(prompt="a cat", negative="dog")'),
  'Let me draw it.',
);
eq('prose: emote + color tags flattened', extractProse('[emote:happy] [c:red]Bright news![/c]'), 'Bright news!');
eq('prose: OOC block removed', extractProse('Real narration. [OOC: meta note here]'), 'Real narration.');
eq('prose: html tags removed', extractProse('Some <b>bold</b> and <br/> text.'), 'Some bold and text.');
eq('prose: markdown image removed', extractProse('Look ![alt text](img.png) at this.'), 'Look at this.');
eq(
  'prose: table rows dropped',
  extractProse('Summary below.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone.'),
  'Summary below. Done.',
);
eq(
  'prose: ANSI color codes stripped',
  extractProse('The \u001b[31mred\u001b[0m alert is \u001b[1mloud\u001b[22m.'),
  'The red alert is loud.',
);
eq(
  'prose: thinking block removed',
  extractProse('<thinking>I should reconsider this</thinking>Here is the answer.'),
  'Here is the answer.',
);
eq(
  'prose: tool_call block removed',
  extractProse('Let me look. <tool_call>{"name":"bash"}</tool_call> Done looking.'),
  'Let me look. Done looking.',
);
eq('prose: TOOL CALLED marker removed', extractProse('Before [TOOL CALLED] after.'), 'Before after.');
eq(
  'prose: stray control chars stripped',
  extractProse('clean\u0007bell and\u0000null text'),
  'clean bell and null text',
);

// ── chunkProse (narration splitter) ─────────────────────────────────
eq('chunk: empty -> []', chunkProse('', 100, 10), []);
eq('chunk: short single -> one chunk', chunkProse('Just one short line.', 100, 10), ['Just one short line.']);
eq('chunk: packs sentences up to cap', chunkProse('One two three. Four five six. Seven eight nine.', 30, 10), [
  'One two three. Four five six.',
  'Seven eight nine.',
]);
eq(
  'chunk: each chunk within cap',
  chunkProse('Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.', 30, 10).every(
    (c) => c.length <= 30,
  ),
  true,
);
eq('chunk: never splits mid-sentence', chunkProse('Short. This is a longer sentence that fits.', 60, 10), [
  'Short. This is a longer sentence that fits.',
]);
eq('chunk: paragraph break forces a boundary', chunkProse('First para.\n\nSecond para.', 100, 10), [
  'First para.',
  'Second para.',
]);
eq('chunk: maxChunks cap drops the tail', chunkProse('A one. B two. C three. D four. E five.', 8, 2), [
  'A one.',
  'B two.',
]);
const longSentence = chunkProse('this is one very long run on clause, with commas, and more commas, going on', 24, 10);
eq(
  'chunk: over-long sentence hard-split, all within cap',
  longSentence.every((c) => c.length <= 24),
  true,
);
eq('chunk: hard-split produced multiple pieces', longSentence.length > 1, true);

// ── extractSegments (narrated roleplay) ─────────────────────────────
eq('segments: empty -> []', extractSegments(''), []);
eq(
  'segments: action then dialogue then action interleave',
  extractSegments('*She grins and waves.* "Hey leader, got work?" *She winks.*'),
  [
    { kind: 'narration', text: 'She grins and waves.' },
    { kind: 'dialogue', text: 'Hey leader, got work?' },
    { kind: 'narration', text: 'She winks.' },
  ],
);
eq('segments: dialogue, tag, dialogue (orphan comma kept as narration)', extractSegments('"Hi," she said, "bye."'), [
  { kind: 'dialogue', text: 'Hi,' },
  { kind: 'narration', text: 'she said,' },
  { kind: 'dialogue', text: 'bye.' },
]);
eq('segments: smart curly quotes recognised', extractSegments('\u201cTargets locked.\u201d she whispered.'), [
  { kind: 'dialogue', text: 'Targets locked.' },
  { kind: 'narration', text: 'she whispered.' },
]);
eq(
  'segments: all narration, no quotes -> one narration segment',
  extractSegments('*She just stares, saying nothing.*'),
  [{ kind: 'narration', text: 'She just stares, saying nothing.' }],
);
eq('segments: all dialogue -> one dialogue segment', extractSegments('"Locked and loaded!"'), [
  { kind: 'dialogue', text: 'Locked and loaded!' },
]);
eq('segments: contraction apostrophe does not split', extractSegments('"It\'s late, don\'t you think?" she sighed.'), [
  { kind: 'dialogue', text: "It's late, don't you think?" },
  { kind: 'narration', text: 'she sighed.' },
]);
eq('segments: code + OOC stripped before segmenting', extractSegments('"Run it." [OOC: meta] ```js\nx=1\n``` *nods*'), [
  { kind: 'dialogue', text: 'Run it.' },
  { kind: 'narration', text: 'nods' },
]);
eq('segments: markdown flattened in narration spans', extractSegments('She reads **the sign** aloud: "This way."'), [
  { kind: 'narration', text: 'She reads the sign aloud:' },
  { kind: 'dialogue', text: 'This way.' },
]);
eq('segments: orphan-punctuation-only narration dropped', extractSegments('"One." - "Two."'), [
  { kind: 'dialogue', text: 'One.' },
  { kind: 'dialogue', text: 'Two.' },
]);

// ── planSegmentRuns (same-voice coalescing) ──────────────────────
const sampleSegs = [
  { kind: 'narration' as const, text: 'She grins.' },
  { kind: 'dialogue' as const, text: 'Hello!' },
  { kind: 'narration' as const, text: 'She waves.' },
  { kind: 'dialogue' as const, text: 'Bye!' },
];
eq('runs: different voices stay separate (interleave)', planSegmentRuns(sampleSegs, 'exusiai', 'narrator'), [
  { voice: 'narrator', hasDialogue: false, text: 'She grins.' },
  { voice: 'exusiai', hasDialogue: true, text: 'Hello!' },
  { voice: 'narrator', hasDialogue: false, text: 'She waves.' },
  { voice: 'exusiai', hasDialogue: true, text: 'Bye!' },
]);
eq('runs: same voice collapses to one run, hasDialogue true', planSegmentRuns(sampleSegs, 'exusiai', 'exusiai'), [
  { voice: 'exusiai', hasDialogue: true, text: 'She grins. Hello! She waves. Bye!' },
]);
eq('runs: null narration voice drops narration (dialogue only)', planSegmentRuns(sampleSegs, 'exusiai', null), [
  { voice: 'exusiai', hasDialogue: true, text: 'Hello! Bye!' },
]);
eq(
  'runs: adjacent same-kind dialogue merges when same voice',
  planSegmentRuns(
    [
      { kind: 'dialogue' as const, text: 'One.' },
      { kind: 'dialogue' as const, text: 'Two.' },
    ],
    'exusiai',
    'narrator',
  ),
  [{ voice: 'exusiai', hasDialogue: true, text: 'One. Two.' }],
);
eq(
  'runs: all-narration with same voice -> hasDialogue false',
  planSegmentRuns([{ kind: 'narration' as const, text: 'Quiet scene.' }], 'exusiai', 'exusiai'),
  [{ voice: 'exusiai', hasDialogue: false, text: 'Quiet scene.' }],
);
eq('runs: empty -> []', planSegmentRuns([], 'exusiai', 'narrator'), []);

console.log(`\ntts config + text helpers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
