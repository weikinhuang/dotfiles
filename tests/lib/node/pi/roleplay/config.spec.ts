/**
 * Tests for lib/node/pi/roleplay/config.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { afterEach, expect, test, vi } from 'vitest';

import {
  clampEnvInt,
  coerceConfigLayer,
  DEFAULT_CONFIG,
  loadRoleplayConfig,
  mergeConfigLayers,
  MAX_REPETITION_NGRAM,
  MAX_REPETITION_WINDOW,
  MAX_SCAN_DEPTH,
  MIN_CHAR_BUDGET,
  MIN_EVENT_CHARS,
  MIN_REPETITION_COUNT,
  MIN_REPETITION_NGRAM,
  MIN_SUMMARY_CHARS,
  MIN_TIMELINE_INJECT_CHARS,
  MIN_TIMELINE_FILE_CHARS,
  MIN_TIMELINE_MEMORY_CHARS,
  MAX_SCENE_FOLD_REFRESH,
  MAX_KEEP_TURNS,
  MAX_RECAP_ADVANCE,
  MAX_RECAP_CHUNK,
  MIN_KEEP_TURNS,
  MIN_RECAP_CHUNK,
  MIN_WINDOW_CHARS,
} from '../../../../../lib/node/pi/roleplay/config.ts';

test('coerceConfigLayer accepts a valid charBudget and floors it', () => {
  expect(coerceConfigLayer({ charBudget: 5000 })).toEqual({ charBudget: 5000 });
  expect(coerceConfigLayer({ charBudget: 10 })).toEqual({ charBudget: MIN_CHAR_BUDGET });
  expect(coerceConfigLayer({ charBudget: 1234.9 })).toEqual({ charBudget: 1234 });
});

test('image mode is opt-in, validated, and layered with an optional workflow', () => {
  expect(DEFAULT_CONFIG.imageMode).toBe('full');
  expect(coerceConfigLayer({ imageMode: 'simple', imageWorkflow: '  qwen  ' })).toEqual({
    imageMode: 'simple',
    imageWorkflow: 'qwen',
  });
  expect(coerceConfigLayer({ imageMode: 'auto', imageWorkflow: ' ' })).toEqual({});
  expect(mergeConfigLayers({ imageMode: 'simple' }, { imageMode: 'off' }).imageMode).toBe('off');
});

test('coerceConfigLayer ignores junk', () => {
  expect(coerceConfigLayer(null)).toEqual({});
  expect(coerceConfigLayer('nope')).toEqual({});
  expect(coerceConfigLayer({ charBudget: 'big' })).toEqual({});
  expect(coerceConfigLayer({ charBudget: Number.NaN })).toEqual({});
  expect(coerceConfigLayer({ unrelated: 1 })).toEqual({});
});

test('coerceConfigLayer accepts loreCharBudget + maxRecursion and clamps them', () => {
  expect(coerceConfigLayer({ loreCharBudget: 4000 })).toEqual({ loreCharBudget: 4000 });
  expect(coerceConfigLayer({ loreCharBudget: 10 })).toEqual({ loreCharBudget: MIN_CHAR_BUDGET });
  expect(coerceConfigLayer({ maxRecursion: 1 })).toEqual({ maxRecursion: 1 });
  expect(coerceConfigLayer({ maxRecursion: 99 })).toEqual({ maxRecursion: 2 }); // clamped to cap
  expect(coerceConfigLayer({ maxRecursion: -5 })).toEqual({ maxRecursion: 0 });
  expect(coerceConfigLayer({ maxRecursion: 1.9 })).toEqual({ maxRecursion: 1 });
});

test('coerceConfigLayer accepts scanDepth and clamps to [1, MAX_SCAN_DEPTH]', () => {
  expect(coerceConfigLayer({ scanDepth: 5 })).toEqual({ scanDepth: 5 });
  expect(coerceConfigLayer({ scanDepth: 0 })).toEqual({ scanDepth: 1 });
  expect(coerceConfigLayer({ scanDepth: 9999 })).toEqual({ scanDepth: MAX_SCAN_DEPTH });
  expect(coerceConfigLayer({ scanDepth: 7.8 })).toEqual({ scanDepth: 7 });
});

test('coerceConfigLayer accepts depthLoreInlineTail only as a boolean', () => {
  expect(coerceConfigLayer({ depthLoreInlineTail: true })).toEqual({ depthLoreInlineTail: true });
  expect(coerceConfigLayer({ depthLoreInlineTail: false })).toEqual({ depthLoreInlineTail: false });
  expect(coerceConfigLayer({ depthLoreInlineTail: 'yes' })).toEqual({});
  // Opt-in: unset must resolve to the standalone-message delivery shape.
  expect(mergeConfigLayers({}).depthLoreInlineTail).toBe(false);
});

test('coerceConfigLayer accepts relationship decay knobs and clamps them', () => {
  expect(coerceConfigLayer({ relationshipDecayPerDay: 2.5 })).toEqual({ relationshipDecayPerDay: 2.5 });
  expect(coerceConfigLayer({ relationshipDecayPerDay: -3 })).toEqual({ relationshipDecayPerDay: 0 });
  expect(coerceConfigLayer({ relationshipBaseline: 40 })).toEqual({ relationshipBaseline: 40 });
  expect(coerceConfigLayer({ relationshipBaseline: 250 })).toEqual({ relationshipBaseline: 100 });
  expect(coerceConfigLayer({ relationshipBaseline: -9 })).toEqual({ relationshipBaseline: 0 });
  expect(coerceConfigLayer({ relationshipBaseline: 33.9 })).toEqual({ relationshipBaseline: 33 });
  expect(coerceConfigLayer({ relationshipDecayPerDay: 'x', relationshipBaseline: Number.NaN })).toEqual({});
});

test('coerceConfigLayer accepts summarize knobs and clamps them', () => {
  expect(coerceConfigLayer({ summarizeMinMessages: 8 })).toEqual({ summarizeMinMessages: 8 });
  expect(coerceConfigLayer({ summarizeMinMessages: 0 })).toEqual({ summarizeMinMessages: 1 });
  expect(coerceConfigLayer({ summarizeMinMessages: 6.7 })).toEqual({ summarizeMinMessages: 6 });
  expect(coerceConfigLayer({ summarizeMaxChars: 3000 })).toEqual({ summarizeMaxChars: 3000 });
  expect(coerceConfigLayer({ summarizeMaxChars: 10 })).toEqual({ summarizeMaxChars: MIN_SUMMARY_CHARS });
  expect(coerceConfigLayer({ summarizeMinMessages: 'x', summarizeMaxChars: Number.NaN })).toEqual({});
});

test('coerceConfigLayer accepts repetition knobs and clamps them', () => {
  expect(coerceConfigLayer({ repetitionEnabled: false })).toEqual({ repetitionEnabled: false });
  expect(coerceConfigLayer({ repetitionNgram: 4 })).toEqual({ repetitionNgram: 4 });
  expect(coerceConfigLayer({ repetitionNgram: 1 })).toEqual({ repetitionNgram: MIN_REPETITION_NGRAM });
  expect(coerceConfigLayer({ repetitionNgram: 999 })).toEqual({ repetitionNgram: MAX_REPETITION_NGRAM });
  expect(coerceConfigLayer({ repetitionWindow: 8 })).toEqual({ repetitionWindow: 8 });
  expect(coerceConfigLayer({ repetitionWindow: 0 })).toEqual({ repetitionWindow: 1 });
  expect(coerceConfigLayer({ repetitionWindow: 9999 })).toEqual({ repetitionWindow: MAX_REPETITION_WINDOW });
  expect(coerceConfigLayer({ repetitionMinCount: 3 })).toEqual({ repetitionMinCount: 3 });
  expect(coerceConfigLayer({ repetitionMinCount: 1 })).toEqual({ repetitionMinCount: MIN_REPETITION_COUNT });
  expect(coerceConfigLayer({ repetitionEnabled: 'x', repetitionNgram: Number.NaN })).toEqual({});
});

test('coerceConfigLayer accepts event knobs and clamps them', () => {
  expect(coerceConfigLayer({ events: ['a storm', '  ', 'a courier', 7] })).toEqual({
    events: ['a storm', 'a courier'],
  });
  expect(coerceConfigLayer({ events: 'nope' })).toEqual({});
  expect(coerceConfigLayer({ eventMaxChars: 300 })).toEqual({ eventMaxChars: 300 });
  expect(coerceConfigLayer({ eventMaxChars: 5 })).toEqual({ eventMaxChars: MIN_EVENT_CHARS });
  expect(coerceConfigLayer({ eventSeedThreads: false })).toEqual({ eventSeedThreads: false });
  expect(coerceConfigLayer({ eventSeedThreads: 'x', eventMaxChars: Number.NaN })).toEqual({});
});

test('coerceConfigLayer accepts rolling-window dials and clamps them', () => {
  expect(coerceConfigLayer({ keepTurns: 12 })).toEqual({ keepTurns: 12 });
  expect(coerceConfigLayer({ keepTurns: 0 })).toEqual({ keepTurns: 1 });
  expect(coerceConfigLayer({ keepTurns: 9999 })).toEqual({ keepTurns: 200 });
  expect(coerceConfigLayer({ recapChunk: 36 })).toEqual({ recapChunk: 36 });
  expect(coerceConfigLayer({ recapChunk: 0 })).toEqual({ recapChunk: 1 });
  expect(coerceConfigLayer({ windowAssistantChars: 150 })).toEqual({ windowAssistantChars: 150 });
  expect(coerceConfigLayer({ windowAssistantChars: 5 })).toEqual({ windowAssistantChars: 40 });
  expect(coerceConfigLayer({ windowUserChars: 500 })).toEqual({ windowUserChars: 500 });
  expect(coerceConfigLayer({ recapStride: 12 })).toEqual({ recapStride: 12 });
  expect(coerceConfigLayer({ recapStride: 0 })).toEqual({ recapStride: 0 });
  expect(coerceConfigLayer({ recapStride: 9999 })).toEqual({ recapStride: 500 });
  expect(coerceConfigLayer({ recapAsync: true })).toEqual({ recapAsync: true });
  expect(coerceConfigLayer({ recapAsync: false })).toEqual({ recapAsync: false });
  expect(coerceConfigLayer({ recapAsync: null })).toEqual({ recapAsync: null });
  expect(coerceConfigLayer({ capture: true })).toEqual({ capture: true });
  expect(coerceConfigLayer({ timeline: true })).toEqual({ timeline: true });
  expect(coerceConfigLayer({ timelineMaxInjectChars: 800 })).toEqual({ timelineMaxInjectChars: 800 });
  expect(coerceConfigLayer({ timelineMaxInjectChars: 10 })).toEqual({
    timelineMaxInjectChars: MIN_TIMELINE_INJECT_CHARS,
  });
  expect(coerceConfigLayer({ recapStride: 'x', recapAsync: 1, capture: 'yes', timeline: 'no' })).toEqual({});
  expect(coerceConfigLayer({ keepTurns: 'x', recapChunk: Number.NaN })).toEqual({});
});

test('mergeConfigLayers applies later layers on top of defaults', () => {
  expect(mergeConfigLayers()).toEqual(DEFAULT_CONFIG);
  expect(mergeConfigLayers({ charBudget: 4000 })).toEqual({ ...DEFAULT_CONFIG, charBudget: 4000 });
  expect(mergeConfigLayers({ charBudget: 4000 }, { charBudget: 6000 })).toEqual({
    ...DEFAULT_CONFIG,
    charBudget: 6000,
  });
  expect(mergeConfigLayers({ loreCharBudget: 5000 }, { maxRecursion: 2 })).toEqual({
    ...DEFAULT_CONFIG,
    loreCharBudget: 5000,
    maxRecursion: 2,
  });
});

test('loadRoleplayConfig falls back to defaults with no files and applies env', () => {
  // No roleplay.json on disk for this cwd -> defaults (env layer empty).
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test')).toEqual(DEFAULT_CONFIG);
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test', 8000)).toEqual({ ...DEFAULT_CONFIG, charBudget: 8000 });
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test', 10)).toEqual({
    ...DEFAULT_CONFIG,
    charBudget: MIN_CHAR_BUDGET,
  });
});

test('loadRoleplayConfig accepts an explicit PI_ROLEPLAY_RECAP_STRIDE of 0 (means follow recapChunk)', () => {
  const prev = process.env.PI_ROLEPLAY_RECAP_STRIDE;
  process.env.PI_ROLEPLAY_RECAP_STRIDE = '0';
  try {
    expect(loadRoleplayConfig('/nonexistent/cwd/for/test').recapStride).toBe(0);
    process.env.PI_ROLEPLAY_RECAP_STRIDE = '3';
    expect(loadRoleplayConfig('/nonexistent/cwd/for/test').recapStride).toBe(3);
    process.env.PI_ROLEPLAY_RECAP_STRIDE = '-2';
    expect(loadRoleplayConfig('/nonexistent/cwd/for/test').recapStride).toBe(DEFAULT_CONFIG.recapStride);
  } finally {
    if (prev === undefined) delete process.env.PI_ROLEPLAY_RECAP_STRIDE;
    else process.env.PI_ROLEPLAY_RECAP_STRIDE = prev;
  }
});

test('coerceConfigLayer validates scene-fold delivery + refresh cadence', () => {
  expect(DEFAULT_CONFIG.sceneFoldDelivery).toBe('reminder');
  expect(DEFAULT_CONFIG.sceneFoldRefreshTurns).toBe(6);
  expect(coerceConfigLayer({ sceneFoldDelivery: 'system' }).sceneFoldDelivery).toBe('system');
  expect(coerceConfigLayer({ sceneFoldDelivery: 'bogus' }).sceneFoldDelivery).toBeUndefined();
  expect(coerceConfigLayer({ sceneFoldRefreshTurns: 0 }).sceneFoldRefreshTurns).toBe(1);
  expect(coerceConfigLayer({ sceneFoldRefreshTurns: 3.7 }).sceneFoldRefreshTurns).toBe(3);
  expect(coerceConfigLayer({ sceneFoldRefreshTurns: 1e6 }).sceneFoldRefreshTurns).toBe(MAX_SCENE_FOLD_REFRESH);
});

test('coerceConfigLayer floors the timeline file + memory caps', () => {
  expect(DEFAULT_CONFIG.timelineFileMaxChars).toBe(65536);
  expect(DEFAULT_CONFIG.timelineMemoryMaxChars).toBe(32768);
  expect(coerceConfigLayer({ timelineFileMaxChars: 10 }).timelineFileMaxChars).toBe(MIN_TIMELINE_FILE_CHARS);
  expect(coerceConfigLayer({ timelineFileMaxChars: 9000 }).timelineFileMaxChars).toBe(9000);
  expect(coerceConfigLayer({ timelineMemoryMaxChars: 1 }).timelineMemoryMaxChars).toBe(MIN_TIMELINE_MEMORY_CHARS);
  expect(coerceConfigLayer({ timelineMemoryMaxChars: 'x' }).timelineMemoryMaxChars).toBeUndefined();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('an explicit recapAsync: null in a later layer resets an earlier force to auto', () => {
  const user = coerceConfigLayer({ recapAsync: true });
  const project = coerceConfigLayer({ recapAsync: null });
  expect(mergeConfigLayers(user, project).recapAsync).toBeNull();
  expect(mergeConfigLayers(user, coerceConfigLayer({})).recapAsync).toBe(true);
});

test('clampEnvInt clamps to [min, max] and falls back only for non-numeric input', () => {
  expect(clampEnvInt('5', 8, 1, 10)).toBe(5);
  expect(clampEnvInt('0', 8, 1, 10)).toBe(1);
  expect(clampEnvInt('-3', 8, 1, 10)).toBe(1);
  expect(clampEnvInt('99', 8, 1, 10)).toBe(10);
  expect(clampEnvInt('abc', 8, 1, 10)).toBe(8);
  expect(clampEnvInt('', 8, 1, 10)).toBe(8);
  expect(clampEnvInt(undefined, 8, 1)).toBe(8);
  expect(clampEnvInt('123456', 8, 1)).toBe(123456);
});

test('loadRoleplayConfig clamps every env-backed numeric knob like the JSON layer', () => {
  const cwd = '/nonexistent/cwd/for/test';
  const cases: [string, keyof typeof DEFAULT_CONFIG, string, number][] = [
    ['PI_ROLEPLAY_CONTEXT_TURNS', 'keepTurns', '0', MIN_KEEP_TURNS],
    ['PI_ROLEPLAY_CONTEXT_TURNS', 'keepTurns', '99999', MAX_KEEP_TURNS],
    ['PI_ROLEPLAY_RECAP_CHUNK', 'recapChunk', '0', MIN_RECAP_CHUNK],
    ['PI_ROLEPLAY_RECAP_CHUNK', 'recapChunk', '99999', MAX_RECAP_CHUNK],
    ['PI_ROLEPLAY_CONTEXT_ASSISTANT_CHARS', 'windowAssistantChars', '5', MIN_WINDOW_CHARS],
    ['PI_ROLEPLAY_CONTEXT_USER_CHARS', 'windowUserChars', '5', MIN_WINDOW_CHARS],
    ['PI_ROLEPLAY_RECAP_STRIDE', 'recapStride', '99999', MAX_RECAP_CHUNK],
    ['PI_ROLEPLAY_RECAP_MAX_ADVANCE', 'recapMaxAdvance', '-4', 0],
    ['PI_ROLEPLAY_RECAP_MAX_ADVANCE', 'recapMaxAdvance', '999999', MAX_RECAP_ADVANCE],
    ['PI_ROLEPLAY_RECAP_LAG_CEILING', 'recapLagCeiling', '999999', MAX_RECAP_ADVANCE],
  ];
  for (const [name, key, raw, want] of cases) {
    vi.stubEnv(name, raw);
    expect(loadRoleplayConfig(cwd)[key], `${name}=${raw}`).toBe(want);
    vi.stubEnv(name, 'junk');
    expect(loadRoleplayConfig(cwd)[key], `${name}=junk`).toBe(DEFAULT_CONFIG[key]);
    vi.unstubAllEnvs();
  }
});
