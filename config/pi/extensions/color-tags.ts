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
import type { ThemeColor } from '@earendil-works/pi-coding-agent';

import { appendColorPrompt, buildColorPromptAddendum } from '../../../lib/node/pi/color-tags/color-prompt.ts';
import {
  applyToMessage,
  type MutableContextMessage,
  type MutableMessage,
  scrubContextMessages,
} from '../../../lib/node/pi/color-tags/transform.ts';
import { buildColorResolver, THEME_COLOR_TOKENS } from '../../../lib/node/pi/color-tags/theme-tokens.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

// ──────────────────────────────────────────────────────────────────────
// Helpers (defined before the extension default export so oxlint's
// no-use-before-define is satisfied without relying on hoisting)
// ──────────────────────────────────────────────────────────────────────

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
    const resolver = buildColorResolver((token) => ctx.ui.theme.getFgAnsi(token as ThemeColor));
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
