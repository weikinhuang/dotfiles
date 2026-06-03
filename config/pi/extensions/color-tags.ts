/**
 * `color-tags` - inline color-tag rewriter for assistant prose.
 *
 * Lets the LLM color short inline runs of its prose by emitting
 * `[c:NAME]content[/c]` tags, which this extension rewrites into ANSI
 * SGR sequences during streaming. Pi's Markdown renderer pipes the
 * resulting text through chalk + `wrapTextWithAnsi`, so colors render
 * naturally next to bold / italic / theme styling.
 *
 * Three hooks:
 *
 *   1. `before_agent_start` - append a `## Inline color tags` block to
 *      the system prompt teaching the model the bracket syntax. Skipped
 *      when `PI_COLOR_TAGS_NO_PROMPT=1`.
 *
 *   2. `message_update` - mutate `event.message.content[i].text` (and
 *      `.thinking`) in place using `rewriteColorTags(text, resolver,
 *      { streaming: true })` so the live render shows colors as the
 *      model types.
 *
 *   3. `context` - scrub ANSI SGR sequences from outgoing assistant
 *      messages BEFORE the next provider request goes out. This is
 *      what stops the feedback loop where the model sees raw
 *      `\x1b[…m` bytes in conversation history (its own past output)
 *      and starts emitting them itself.
 *
 * **Why we don't restore the message at message_end.** Pi's order on
 * `message_end` is: extension handlers run first, THEN listeners
 * (interactive-mode's `streamingComponent.updateContent`), THEN
 * session-write. All three consume the same `event.message` object,
 * and `MessageEndEventResult.message` mutates that object in place
 * (see `agent-session.js`'s `_replaceMessageInPlace`). So returning a
 * bracket-restored message at message_end would correctly clean
 * session JSONL, but ALSO replace the colored live render with raw
 * `[c:NAME]` text - permanently, until the user typed again. Keeping
 * the live render colored is the priority; the cosmetic side effect
 * is `\u001b` bytes in the on-disk session JSONL. The `context` hook
 * scrubs those bytes before they reach the model on the next turn or
 * on `pi --resume`, so there's no functional consequence to the
 * dirty JSONL.
 *
 * Pure helpers live under `../../../lib/node/pi/color-tags/` and don't
 * import from `@earendil-works/*`, so they're unit-testable under the
 * root vitest suite.
 *
 * Environment:
 *   PI_COLOR_TAGS_DISABLED=1   skip the extension entirely
 *   PI_COLOR_TAGS_NO_PROMPT=1  keep the rewriter, drop the system-prompt
 *                              addendum (A/B harness)
 *   PI_COLOR_TAGS_DISABLE_SCRUB=1  debug: leave raw `[c:NAME]...[/c]` tags
 *                              in the visible reply and in history instead
 *                              of rewriting them to ANSI and scrubbing the
 *                              ANSI back out. Same effect as the
 *                              `--color-tags-no-scrub` CLI flag.
 *   PI_COLOR_TAGS_TRACE=<path> append per-event diagnostics to <path>
 *                              (default off; set to `off` to disable
 *                              explicitly)
 */

import { appendFileSync } from 'node:fs';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

import { appendColorPrompt, buildColorPromptAddendum } from '../../../lib/node/pi/color-tags/color-prompt.ts';
import { type ColorResolver, rewriteColorTags } from '../../../lib/node/pi/color-tags/parse-color-tags.ts';
import { CLOSE_FG, ESC, resolveColor } from '../../../lib/node/pi/color-tags/resolve-color.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

// ──────────────────────────────────────────────────────────────────────
// Theme tokens
// ──────────────────────────────────────────────────────────────────────

/**
 * Hardcoded mirror of the `ThemeColor` union exported by
 * `@earendil-works/pi-coding-agent/.../theme/theme.d.ts`. The type
 * itself is type-only at runtime so we can't iterate it - keep this
 * list in lockstep with the upstream `.d.ts` manually. Used both to
 * advertise theme-token names in the system-prompt addendum and to
 * route bracket-tag names to `theme.getFgAnsi(...)` instead of the pure
 * named-16 / 256 / hex resolver.
 */
const THEME_COLOR_TOKENS: readonly ThemeColor[] = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'bashMode',
];

const THEME_COLOR_SET: ReadonlySet<string> = new Set(THEME_COLOR_TOKENS);

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of an assistant content part we mutate. Mirrors
 * `TextContent` / `ThinkingContent` from `@earendil-works/pi-ai` but
 * narrowed to the two fields we actually touch.
 */
interface MutableContentPart {
  type?: string;
  text?: string;
  thinking?: string;
}

interface MutableMessage {
  role?: string;
  content?: MutableContentPart[];
}

interface MutableContextMessage {
  role?: string;
  content?: MutableContentPart[];
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (defined before the extension default export so oxlint's
// no-use-before-define is satisfied without relying on hoisting)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a fresh resolver bound to the given theme. Theme tokens take
 * priority over the pure named/256/hex resolver so a theme-defined
 * `accent` doesn't get shadowed by an unrelated 16-color name in some
 * future expansion of the named set.
 */
function buildResolver(theme: Theme): ColorResolver {
  return (rawName) => {
    const name = rawName.trim();
    if (name.length === 0) return undefined;
    if (THEME_COLOR_SET.has(name)) {
      return { open: theme.getFgAnsi(name as ThemeColor), close: CLOSE_FG };
    }
    return resolveColor(name);
  };
}

/**
 * Strip every ANSI SGR (`\x1b[…m`) sequence from `text`. Used by the
 * `context` handler to scrub history before it reaches the LLM. The
 * regex matches CSI sequences ending in `m` - narrow enough that
 * tool output containing other ANSI controls (cursor moves etc.) is
 * left alone.
 */
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
function stripAnsi(text: string): string {
  return text.replace(SGR_PATTERN, '');
}

/**
 * Mutate text / thinking content parts in `message` in place. Pi
 * reads the same content array reference from `event.message.content`
 * during render, so an in-place mutation is what makes the colors
 * show up live.
 */
function applyToMessage(message: MutableMessage, resolver: ColorResolver): void {
  if (message.role !== 'assistant') return;
  const parts = message.content;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.length > 0) {
      part.text = rewriteColorTags(part.text, resolver, { streaming: true });
    }
    if (typeof part.thinking === 'string' && part.thinking.length > 0) {
      part.thinking = rewriteColorTags(part.thinking, resolver, { streaming: true });
    }
  }
}

/**
 * Append a one-line per-event diagnostic to `PI_COLOR_TAGS_TRACE` if
 * set. Best-effort - all IO errors are swallowed because failing to
 * log must not break the live stream. Default off; set the env var
 * to a writable path to enable.
 */
function traceMessageUpdate(message: MutableMessage): void {
  const tracePath = process.env.PI_COLOR_TAGS_TRACE;
  if (typeof tracePath !== 'string' || tracePath.length === 0 || tracePath === 'off') return;
  if (!Array.isArray(message.content)) return;
  const snapshot = message.content
    .map((p) => {
      if (typeof p?.text === 'string') return `[text len=${p.text.length}] ${p.text.slice(-200)}`;
      if (typeof p?.thinking === 'string') return `[thinking len=${p.thinking.length}] ${p.thinking.slice(-120)}`;
      return `[${p?.type ?? '?'}]`;
    })
    .join(' || ');
  const openCount = snapshot.split('[c:').length - 1;
  const closeCount = snapshot.split('[/c]').length - 1;
  try {
    appendFileSync(
      tracePath,
      `${new Date().toISOString()} parts=${message.content.length} [c:openCount=${openCount} [/c]closeCount=${closeCount}\n  snapshot: ${JSON.stringify(snapshot)}\n`,
    );
  } catch {
    // swallow: trace is best-effort, never break the stream on log IO.
  }
}

/**
 * Belt-and-suspenders ANSI scrub for outgoing context messages. Only
 * touches assistant parts that contain `\x1b` and only allocates a
 * new message when something actually changed.
 *
 * `Object.assign({}, ...)` instead of object spread to satisfy
 * oxlint's `oxc(no-map-spread)` rule.
 */
function scrubContextMessages(messages: MutableContextMessage[]): { messages: MutableContextMessage[] } | undefined {
  let outerMutated = false;
  const next = messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    let partsMutated = false;
    const newContent = m.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const newPart: MutableContentPart = Object.assign({}, part);
      if (typeof part.text === 'string' && part.text.includes(ESC)) {
        newPart.text = stripAnsi(part.text);
        partsMutated = true;
      }
      if (typeof part.thinking === 'string' && part.thinking.includes(ESC)) {
        newPart.thinking = stripAnsi(part.thinking);
        partsMutated = true;
      }
      return newPart;
    });
    if (partsMutated) {
      outerMutated = true;
      return Object.assign({}, m, { content: newContent });
    }
    return m;
  });
  return outerMutated ? { messages: next } : undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function colorTags(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COLOR_TAGS_DISABLED)) return;

  const promptDisabled = envTruthy(process.env.PI_COLOR_TAGS_NO_PROMPT);

  pi.registerFlag('color-tags-no-scrub', {
    description: 'Debug: leave raw [c:NAME]...[/c] tags in the reply/history instead of rewriting to ANSI',
    type: 'boolean',
    default: false,
  });

  // When true, skip the live rewrite and the history scrub so the raw
  // `[c:NAME]` tags stay visible for debugging. Env sets a baseline; the
  // CLI flag is resolved lazily (getFlag is only callable once the runtime
  // has parsed argv) and memoized on first hook invocation.
  const keepRawEnv = envTruthy(process.env.PI_COLOR_TAGS_DISABLE_SCRUB);
  let keepRawFlag: boolean | undefined;
  const keepRaw = (): boolean => {
    if (keepRawFlag === undefined) {
      try {
        keepRawFlag = pi.getFlag('color-tags-no-scrub') === true;
      } catch {
        keepRawFlag = false;
      }
    }
    return keepRawEnv || keepRawFlag;
  };

  if (!promptDisabled) {
    pi.on('before_agent_start', (event, ctx) => {
      const base = (event as { systemPrompt?: string }).systemPrompt ?? ctx.getSystemPrompt();
      const addendum = buildColorPromptAddendum({ themeTokens: THEME_COLOR_TOKENS });
      return { systemPrompt: appendColorPrompt(base, addendum) };
    });
  }

  pi.on('message_update', (event, ctx) => {
    const message = (event as { message?: MutableMessage }).message;
    if (message?.role !== 'assistant') return undefined;
    if (keepRaw()) {
      traceMessageUpdate(message);
      return undefined;
    }
    const resolver = buildResolver(ctx.ui.theme);
    applyToMessage(message, resolver);
    traceMessageUpdate(message);
    return undefined;
  });

  pi.on('context', (event) => {
    if (keepRaw()) return undefined;
    const messages = (event as { messages?: MutableContextMessage[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    const result = scrubContextMessages(messages);
    return result ? { messages: result.messages as never } : undefined;
  });
}
