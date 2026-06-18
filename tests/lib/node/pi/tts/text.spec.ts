/**
 * Tests for lib/node/pi/tts/text.ts - dialogue extraction, OOC pause/resume
 * detection, prose normalization for narration, sentence/paragraph chunking,
 * reading-order segmentation, and same-voice run coalescing.
 *
 * Ported from the pre-promotion hand-rolled `test-tts.ts` runner into the
 * repo's vitest convention (one `test.each` row per assertion).
 */

import { expect, test } from 'vitest';

import {
  extractDialogue,
  detectOoc,
  extractProse,
  chunkProse,
  extractSegments,
  planSegmentRuns,
} from '../../../../../lib/node/pi/tts/text.ts';

/** A single deep-equality case: name, lazily-evaluated actual, expected. */
type Case = [name: string, got: () => unknown, want: unknown];

const longSentence = chunkProse('this is one very long run on clause, with commas, and more commas, going on', 24, 10);

const sampleSegs = [
  { kind: 'narration' as const, text: 'She grins.' },
  { kind: 'dialogue' as const, text: 'Hello!' },
  { kind: 'narration' as const, text: 'She waves.' },
  { kind: 'dialogue' as const, text: 'Bye!' },
];

const cases: Case[] = [
  // ── extractDialogue ────────────────────────────────────────────────
  [
    'dialogue: straight quotes, drop action prose',
    () => extractDialogue('*She grins and waves.* "Hey leader, got some work for us?" *She winks.*'),
    'Hey leader, got some work for us?',
  ],
  ['dialogue: smart curly quotes', () => extractDialogue('\u201cTargets locked.\u201d she said.'), 'Targets locked.'],
  ['dialogue: multiple spans concatenated', () => extractDialogue('"First." *beat* "Second."'), 'First. Second.'],
  [
    'dialogue: contraction apostrophe does not break the span',
    () => extractDialogue(`"It's late, you should rest, don't you think?"`),
    `It's late, you should rest, don't you think?`,
  ],
  ['dialogue: no dialogue -> empty', () => extractDialogue('*She just stares, saying nothing.*'), ''],
  ['dialogue: empty input -> empty', () => extractDialogue(''), ''],
  ['dialogue: OOC block excluded', () => extractDialogue('"Real line." [OOC: "this is meta"]'), 'Real line.'],
  [
    'dialogue: fenced code excluded',
    () => extractDialogue('"Speak this." ```js\nconst x = "not this";\n```'),
    'Speak this.',
  ],
  [
    'dialogue: emote + color tags stripped, inner text kept',
    () => extractDialogue('[emote:happy] [c:red]"Hello there!"[/c]'),
    'Hello there!',
  ],
  [
    'dialogue: literal generate_image call excluded',
    () => extractDialogue('"Say cheese!" generate_image(prompt="1girl, smiling", negative="bad")'),
    'Say cheese!',
  ],

  // ── detectOoc ──────────────────────────────────────────────────────
  ['ooc: detect pause', () => detectOoc('text [OOC: PAUSE] more'), 'pause'],
  ['ooc: detect resume', () => detectOoc('[OOC: RESUME now]'), 'resume'],
  ['ooc: resume wins when both', () => detectOoc('[OOC: PAUSE] [OOC: RESUME]'), 'resume'],
  ['ooc: none -> null', () => detectOoc('just a normal line'), null],

  // ── extractProse (narration) ───────────────────────────────────────
  ['prose: empty -> empty', () => extractProse(''), ''],
  ['prose: plain text passes', () => extractProse('Hello there, friend.'), 'Hello there, friend.'],
  [
    'prose: fenced code removed',
    () => extractProse('Here is the fix:\n```js\nconst x = 1;\n```\nThat should work.'),
    'Here is the fix: That should work.',
  ],
  [
    'prose: inline code keeps token, drops backticks',
    () => extractProse('Call the `foo` function now.'),
    'Call the foo function now.',
  ],
  [
    'prose: markdown link keeps text, drops url',
    () => extractProse('See [the docs](https://example.com/page) for more.'),
    'See the docs for more.',
  ],
  ['prose: bare url removed', () => extractProse('Go to https://example.com now.'), 'Go to now.'],
  [
    'prose: emphasis markers stripped',
    () => extractProse('This is **very** _important_ and ~~old~~ stuff.'),
    'This is very important and old stuff.',
  ],
  [
    'prose: heading + bullets flattened',
    () => extractProse('# Title\n\n- first point\n- second point'),
    'Title first point second point',
  ],
  ['prose: ordered list markers flattened', () => extractProse('1. do this\n2. then that'), 'do this then that'],
  ['prose: blockquote marker dropped', () => extractProse('> a quoted line'), 'a quoted line'],
  [
    'prose: generate_image call removed',
    () => extractProse('Let me draw it. generate_image(prompt="a cat", negative="dog")'),
    'Let me draw it.',
  ],
  ['prose: emote + color tags flattened', () => extractProse('[emote:happy] [c:red]Bright news![/c]'), 'Bright news!'],
  ['prose: OOC block removed', () => extractProse('Real narration. [OOC: meta note here]'), 'Real narration.'],
  ['prose: html tags removed', () => extractProse('Some <b>bold</b> and <br/> text.'), 'Some bold and text.'],
  ['prose: markdown image removed', () => extractProse('Look ![alt text](img.png) at this.'), 'Look at this.'],
  [
    'prose: table rows dropped',
    () => extractProse('Summary below.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone.'),
    'Summary below. Done.',
  ],
  [
    'prose: ANSI color codes stripped',
    () => extractProse('The \u001b[31mred\u001b[0m alert is \u001b[1mloud\u001b[22m.'),
    'The red alert is loud.',
  ],
  [
    'prose: thinking block removed',
    () => extractProse('<thinking>I should reconsider this</thinking>Here is the answer.'),
    'Here is the answer.',
  ],
  [
    'prose: tool_call block removed',
    () => extractProse('Let me look. <tool_call>{"name":"bash"}</tool_call> Done looking.'),
    'Let me look. Done looking.',
  ],
  ['prose: TOOL CALLED marker removed', () => extractProse('Before [TOOL CALLED] after.'), 'Before after.'],
  [
    'prose: stray control chars stripped',
    () => extractProse('clean\u0007bell and\u0000null text'),
    'clean bell and null text',
  ],

  // ── chunkProse (narration splitter) ────────────────────────────────
  ['chunk: empty -> []', () => chunkProse('', 100, 10), []],
  ['chunk: short single -> one chunk', () => chunkProse('Just one short line.', 100, 10), ['Just one short line.']],
  [
    'chunk: packs sentences up to cap',
    () => chunkProse('One two three. Four five six. Seven eight nine.', 30, 10),
    ['One two three. Four five six.', 'Seven eight nine.'],
  ],
  [
    'chunk: each chunk within cap',
    () =>
      chunkProse('Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.', 30, 10).every(
        (c) => c.length <= 30,
      ),
    true,
  ],
  [
    'chunk: never splits mid-sentence',
    () => chunkProse('Short. This is a longer sentence that fits.', 60, 10),
    ['Short. This is a longer sentence that fits.'],
  ],
  [
    'chunk: paragraph break forces a boundary',
    () => chunkProse('First para.\n\nSecond para.', 100, 10),
    ['First para.', 'Second para.'],
  ],
  [
    'chunk: maxChunks cap drops the tail',
    () => chunkProse('A one. B two. C three. D four. E five.', 8, 2),
    ['A one.', 'B two.'],
  ],
  // ── chunkProse sentinels (server-side chunking) ──────────────────────
  [
    'chunk: maxChars<0 -> whole text as one chunk (newlines preserved)',
    () => chunkProse('First para.\n\nSecond para. Third sentence.', -1, 10),
    ['First para.\n\nSecond para. Third sentence.'],
  ],
  ['chunk: any negative is the no-split sentinel', () => chunkProse('One. Two. Three.', -42, 10), ['One. Two. Three.']],
  [
    'chunk: maxChars===0 -> split by paragraph only (no sentence packing)',
    () => chunkProse('One. Two. Three.\n\nFour. Five.', 0, 10),
    ['One. Two. Three.', 'Four. Five.'],
  ],
  [
    'chunk: maxChars===0 collapses intra-paragraph whitespace',
    () => chunkProse('Line one\nstill para one.\n\nPara two.', 0, 10),
    ['Line one still para one.', 'Para two.'],
  ],
  ['chunk: maxChars===0 still honors maxChunks cap', () => chunkProse('A.\n\nB.\n\nC.\n\nD.', 0, 2), ['A.', 'B.']],
  ['chunk: over-long sentence hard-split, all within cap', () => longSentence.every((c) => c.length <= 24), true],
  ['chunk: hard-split produced multiple pieces', () => longSentence.length > 1, true],

  // ── extractSegments (narrated roleplay) ────────────────────────────
  ['segments: empty -> []', () => extractSegments(''), []],
  [
    'segments: action then dialogue then action interleave',
    () => extractSegments('*She grins and waves.* "Hey leader, got work?" *She winks.*'),
    [
      { kind: 'narration', text: 'She grins and waves.' },
      { kind: 'dialogue', text: 'Hey leader, got work?' },
      { kind: 'narration', text: 'She winks.' },
    ],
  ],
  [
    'segments: dialogue, tag, dialogue (orphan comma kept as narration)',
    () => extractSegments('"Hi," she said, "bye."'),
    [
      { kind: 'dialogue', text: 'Hi,' },
      { kind: 'narration', text: 'she said,' },
      { kind: 'dialogue', text: 'bye.' },
    ],
  ],
  [
    'segments: smart curly quotes recognised',
    () => extractSegments('\u201cTargets locked.\u201d she whispered.'),
    [
      { kind: 'dialogue', text: 'Targets locked.' },
      { kind: 'narration', text: 'she whispered.' },
    ],
  ],
  [
    'segments: all narration, no quotes -> one narration segment',
    () => extractSegments('*She just stares, saying nothing.*'),
    [{ kind: 'narration', text: 'She just stares, saying nothing.' }],
  ],
  [
    'segments: all dialogue -> one dialogue segment',
    () => extractSegments('"Locked and loaded!"'),
    [{ kind: 'dialogue', text: 'Locked and loaded!' }],
  ],
  [
    'segments: contraction apostrophe does not split',
    () => extractSegments('"It\'s late, don\'t you think?" she sighed.'),
    [
      { kind: 'dialogue', text: "It's late, don't you think?" },
      { kind: 'narration', text: 'she sighed.' },
    ],
  ],
  [
    'segments: code + OOC stripped before segmenting',
    () => extractSegments('"Run it." [OOC: meta] ```js\nx=1\n``` *nods*'),
    [
      { kind: 'dialogue', text: 'Run it.' },
      { kind: 'narration', text: 'nods' },
    ],
  ],
  [
    'segments: markdown flattened in narration spans',
    () => extractSegments('She reads **the sign** aloud: "This way."'),
    [
      { kind: 'narration', text: 'She reads the sign aloud:' },
      { kind: 'dialogue', text: 'This way.' },
    ],
  ],
  [
    'segments: orphan-punctuation-only narration dropped',
    () => extractSegments('"One." - "Two."'),
    [
      { kind: 'dialogue', text: 'One.' },
      { kind: 'dialogue', text: 'Two.' },
    ],
  ],

  // ── planSegmentRuns (same-voice coalescing) ───────────────────────
  [
    'runs: different voices stay separate (interleave)',
    () => planSegmentRuns(sampleSegs, 'exusiai', 'narrator'),
    [
      { voice: 'narrator', hasDialogue: false, text: 'She grins.' },
      { voice: 'exusiai', hasDialogue: true, text: 'Hello!' },
      { voice: 'narrator', hasDialogue: false, text: 'She waves.' },
      { voice: 'exusiai', hasDialogue: true, text: 'Bye!' },
    ],
  ],
  [
    'runs: same voice collapses to one run, hasDialogue true',
    () => planSegmentRuns(sampleSegs, 'exusiai', 'exusiai'),
    [{ voice: 'exusiai', hasDialogue: true, text: 'She grins. Hello! She waves. Bye!' }],
  ],
  [
    'runs: splitByKind keeps dialogue/narration separate even with one voice',
    () => planSegmentRuns(sampleSegs, 'exusiai', 'exusiai', true),
    [
      { voice: 'exusiai', hasDialogue: false, text: 'She grins.' },
      { voice: 'exusiai', hasDialogue: true, text: 'Hello!' },
      { voice: 'exusiai', hasDialogue: false, text: 'She waves.' },
      { voice: 'exusiai', hasDialogue: true, text: 'Bye!' },
    ],
  ],
  [
    'runs: splitByKind still merges adjacent same-kind same-voice segments',
    () =>
      planSegmentRuns(
        [
          { kind: 'dialogue' as const, text: 'One.' },
          { kind: 'dialogue' as const, text: 'Two.' },
          { kind: 'narration' as const, text: 'She paused.' },
        ],
        'exusiai',
        'exusiai',
        true,
      ),
    [
      { voice: 'exusiai', hasDialogue: true, text: 'One. Two.' },
      { voice: 'exusiai', hasDialogue: false, text: 'She paused.' },
    ],
  ],
  [
    'runs: null narration voice drops narration (dialogue only)',
    () => planSegmentRuns(sampleSegs, 'exusiai', null),
    [{ voice: 'exusiai', hasDialogue: true, text: 'Hello! Bye!' }],
  ],
  [
    'runs: adjacent same-kind dialogue merges when same voice',
    () =>
      planSegmentRuns(
        [
          { kind: 'dialogue' as const, text: 'One.' },
          { kind: 'dialogue' as const, text: 'Two.' },
        ],
        'exusiai',
        'narrator',
      ),
    [{ voice: 'exusiai', hasDialogue: true, text: 'One. Two.' }],
  ],
  [
    'runs: all-narration with same voice -> hasDialogue false',
    () => planSegmentRuns([{ kind: 'narration' as const, text: 'Quiet scene.' }], 'exusiai', 'exusiai'),
    [{ voice: 'exusiai', hasDialogue: false, text: 'Quiet scene.' }],
  ],
  ['runs: empty -> []', () => planSegmentRuns([], 'exusiai', 'narrator'), []],
];

test.each(cases)('%s', (_name, got, want) => {
  expect(got()).toEqual(want);
});
