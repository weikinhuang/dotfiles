/**
 * Tests for lib/node/pi/color-tags/parse-color-tags.ts.
 */

import { describe, expect, test } from 'vitest';

import { type ColorResolver, rewriteColorTags } from '../../../../../lib/node/pi/color-tags/parse-color-tags.ts';
import { ESC } from '../../../../../lib/node/pi/color-tags/resolve-color.ts';

const OPEN_RED = `${ESC}[31m`;
const OPEN_GREEN = `${ESC}[32m`;
const CLOSE = `${ESC}[39m`;

const FAKE_COLORS: Record<string, { open: string; close: string }> = {
  red: { open: OPEN_RED, close: CLOSE },
  green: { open: OPEN_GREEN, close: CLOSE },
};

const fakeResolver: ColorResolver = (name) => FAKE_COLORS[name.trim()];

describe('rewriteColorTags: closed pairs (always)', () => {
  test('rewrites a single fully-closed pair', () => {
    expect(rewriteColorTags('hello [c:red]world[/c]!', fakeResolver)).toBe(`hello ${OPEN_RED}world${CLOSE}!`);
  });

  test('rewrites multiple pairs in one string', () => {
    const out = rewriteColorTags('[c:red]a[/c] and [c:green]b[/c]', fakeResolver);
    expect(out).toBe(`${OPEN_RED}a${CLOSE} and ${OPEN_GREEN}b${CLOSE}`);
  });

  test('non-greedy: nested-looking [c:...] inside content is consumed by the FIRST [/c]', () => {
    // Spec says nesting is treated as part of the outer span's
    // content, so the regex matches `[c:red]inner [c:green]x[/c]` as
    // one span (name=red, content="inner [c:green]x") and the
    // trailing `[/c]` closes it.
    const out = rewriteColorTags('[c:red]inner [c:green]x[/c] tail', fakeResolver);
    expect(out).toBe(`${OPEN_RED}inner [c:green]x${CLOSE} tail`);
  });

  test('unknown color name leaves the literal tag in place', () => {
    expect(rewriteColorTags('[c:nope]x[/c]', fakeResolver)).toBe('[c:nope]x[/c]');
  });

  test('runs even without streaming flag', () => {
    expect(rewriteColorTags('[c:red]x[/c]', fakeResolver, { streaming: false })).toBe(`${OPEN_RED}x${CLOSE}`);
    expect(rewriteColorTags('[c:red]x[/c]', fakeResolver)).toBe(`${OPEN_RED}x${CLOSE}`);
  });

  test('passes through plain text untouched', () => {
    expect(rewriteColorTags('no tags here', fakeResolver)).toBe('no tags here');
  });

  test('empty input returns empty', () => {
    expect(rewriteColorTags('', fakeResolver)).toBe('');
  });

  test('does not collide with markdown link syntax', () => {
    // `[text](url)` - link form has `(url)` after; color tags do not.
    // Closed pair pattern `[c:NAME]...[/c]` is structurally distinct.
    const md = '[click me](https://example.com) and [^1] and [ ] todo';
    expect(rewriteColorTags(md, fakeResolver)).toBe(md);
  });

  test('does not rewrite the guillemet-form (the prior Claude auto-render bug)', () => {
    // The guillemet form `«c:red»X«/c»` was tried and rejected because
    // Claude auto-converts it to raw ANSI bytes (model-trained
    // reflex). Our bracket-form rewriter must NOT match the literal
    // guillemet text - if a model accidentally types it, it stays
    // visible so the failure is debuggable.
    const md = 'see «c:red»error«/c» vs the bracket form';
    expect(rewriteColorTags(md, fakeResolver)).toBe(md);
  });

  test('does not rewrite the curly-form (the earlier prior shape)', () => {
    const md = 'see {c:red}error{/c} vs the bracket form';
    expect(rewriteColorTags(md, fakeResolver)).toBe(md);
  });

  test('JSON-like literals pass through (brackets in array context)', () => {
    const json = 'config: [1, 2, "[c:red]not closed inside json", 3]';
    // The fragment `[c:red]not closed inside json", 3]` actually does
    // match the closed-tag regex (open `[c:red]`, close `]`... wait
    // no - close requires `[/c]`, not bare `]`. So the JSON passes
    // through.
    expect(rewriteColorTags(json, fakeResolver)).toBe(json);
  });

  test('list / task-list / footnote markers pass through (no [c:] prefix)', () => {
    const list = '- [ ] item one\n- [x] item two\nSee [^1] reference';
    expect(rewriteColorTags(list, fakeResolver)).toBe(list);
  });
});

describe('rewriteColorTags: streaming-only behaviours', () => {
  test('open-without-close at end is rewritten when streaming', () => {
    expect(rewriteColorTags('hello [c:red]still typing', fakeResolver, { streaming: true })).toBe(
      `hello ${OPEN_RED}still typing`,
    );
  });

  test('orphan close [/c] is converted to close ANSI under streaming', () => {
    // Critical regression: the agent-core `content.text += delta`
    // accumulation means our previous-chunk pass-2 rewrite of the
    // open persists, and the close arrives orphaned. Without pass 3
    // the user would see literal `[/c]` after a colored span.
    const previousChunk = `hello ${OPEN_RED}still typing`;
    const cumulative = `${previousChunk}[/c] more`;
    expect(rewriteColorTags(cumulative, fakeResolver, { streaming: true })).toBe(
      `hello ${OPEN_RED}still typing${CLOSE} more`,
    );
  });

  test('two-chunk progression: [c:red]foo → [c:red]foo[/c] in [c:green]bar[/c]', () => {
    // Simulates the real streaming loop. Chunk 1: open without
    // close. Chunk 2: cumulative text with previous mutation
    // appended.
    const chunk1 = rewriteColorTags('The build [c:red]failed', fakeResolver, { streaming: true });
    expect(chunk1).toBe(`The build ${OPEN_RED}failed`);
    const chunk2Cumulative = `${chunk1}[/c] in [c:green]2.3s[/c]`;
    expect(rewriteColorTags(chunk2Cumulative, fakeResolver, { streaming: true })).toBe(
      `The build ${OPEN_RED}failed${CLOSE} in ${OPEN_GREEN}2.3s${CLOSE}`,
    );
  });

  test('orphan close with no preceding open emits stray close ANSI (harmless terminal no-op)', () => {
    // Edge case: model emits `[/c]` without an open. Pass 3 fires
    // anyway, emitting `\x1b[39m`. Visually invisible - default-fg
    // reset on no active fg is a no-op.
    expect(rewriteColorTags('hello [/c] world', fakeResolver, { streaming: true })).toBe(`hello ${CLOSE} world`);
  });

  test('open-without-close is left untouched when streaming is off', () => {
    expect(rewriteColorTags('hello [c:red]still typing', fakeResolver, { streaming: false })).toBe(
      'hello [c:red]still typing',
    );
  });

  test('orphan [/c] is left untouched when streaming is off', () => {
    // Non-streaming callers see already-finalised text. An orphan
    // close in finalised text is a model bug, not our fix to make.
    expect(rewriteColorTags('hello [/c] world', fakeResolver, { streaming: false })).toBe('hello [/c] world');
  });

  test('open-without-close + unknown name leaves literal tag', () => {
    expect(rewriteColorTags('hello [c:nope]still typing', fakeResolver, { streaming: true })).toBe(
      'hello [c:nope]still typing',
    );
  });

  test('partial open at end is left visible during streaming (no destructive suppression)', () => {
    // Partial-open suppression was removed because it destructively
    // mutated the text - agent-core's `text += delta` accumulation
    // meant stripped `[c:re` bytes were never recovered, leaving
    // `:red]content` literal forever once the rest streamed in.
    // Trade-off: a one-frame literal `[c:re` flash on screen during
    // mid-name chunks. The next chunk completes the open and pass 1
    // / pass 2 rewrite cleanly.
    expect(rewriteColorTags('hello [c:re', fakeResolver, { streaming: true })).toBe('hello [c:re');
    expect(rewriteColorTags('hello [c:', fakeResolver, { streaming: true })).toBe('hello [c:');
    expect(rewriteColorTags('hello [c', fakeResolver, { streaming: true })).toBe('hello [c');
  });

  test('bare trailing [ is left visible (markdown-link safety)', () => {
    expect(rewriteColorTags('see the link [', fakeResolver, { streaming: true })).toBe('see the link [');
    expect(rewriteColorTags('todo [ ', fakeResolver, { streaming: true })).toBe('todo [ ');
  });

  test('partial open at end is preserved when streaming is off', () => {
    expect(rewriteColorTags('hello [c:re', fakeResolver, { streaming: false })).toBe('hello [c:re');
  });

  test('closed pair earlier in stream survives partial open at the very end', () => {
    const out = rewriteColorTags('[c:red]first[/c] and then [c:gr', fakeResolver, { streaming: true });
    // First pair fully colored, partial trailing open left visible.
    expect(out).toBe(`${OPEN_RED}first${CLOSE} and then [c:gr`);
  });

  test('open-without-close preempts partial-open suppression when name is valid', () => {
    // `[c:red]` is a complete open tag (resolver finds it) - we open
    // the span and let the rest stream in.
    expect(rewriteColorTags('hello [c:red]', fakeResolver, { streaming: true })).toBe(`hello ${OPEN_RED}`);
  });

  test('does not strip brackets in middle of text', () => {
    expect(rewriteColorTags('see [click](url) and [^1] note', fakeResolver, { streaming: true })).toBe(
      'see [click](url) and [^1] note',
    );
  });
});

describe('rewriteColorTags: idempotency on already-rewritten text', () => {
  test('text that already contains ANSI from a prior pass is left untouched', () => {
    // Simulates the next streaming event arriving with the previous
    // mutation still in `event.message.content[i].text`.
    const already = `prefix ${OPEN_RED}hi${CLOSE} suffix`;
    expect(rewriteColorTags(already, fakeResolver, { streaming: true })).toBe(already);
  });

  test('mixed already-rewritten ANSI plus a fresh tag rewrites only the fresh tag', () => {
    const mixed = `prefix ${OPEN_RED}hi${CLOSE} [c:green]x[/c]`;
    expect(rewriteColorTags(mixed, fakeResolver, { streaming: true })).toBe(
      `prefix ${OPEN_RED}hi${CLOSE} ${OPEN_GREEN}x${CLOSE}`,
    );
  });
});
