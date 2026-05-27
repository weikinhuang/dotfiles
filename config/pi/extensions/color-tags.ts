/**
 * `color-tags` - inline color-tag rewriter for assistant prose.
 *
 * Lets the LLM color short inline runs of its prose by emitting
 * `[c:NAME]content[/c]` tags, which this extension rewrites into ANSI
 * SGR sequences during streaming. Pi's Markdown renderer pipes the
 * resulting text through chalk + `wrapTextWithAnsi`, so colors render
 * naturally next to bold / italic / theme styling.
 *
 * Scope is intentionally minimal:
 *   - Streaming rewrite only (`message_update`).
 *   - No `message_end` mutation: the prototype showed pi persists the
 *     rewritten ANSI into session storage and then the model
 *     pattern-matches its own raw escape bytes from history. We
 *     deliberately leave session storage in the original `[c:NAME]`
 *     syntax.
 *   - No `before_provider_request` ANSI scrub: not needed when we don't
 *     mutate at `message_end`.
 *   - Foreground only (no `[bg:...]`).
 *
 * The trade-off of streaming-only is a brief raw-tag flash at the very
 * end of the stream: pi's interactive `case "message_end"` handler
 * calls `streamingComponent.updateContent(event.message)` with a fresh
 * agent clone of the final message, which doesn't have our mutation.
 * Documented in `color-tags.md` under "Known limits".
 *
 * Hooks (only two):
 *
 *   1. `before_agent_start` - append a `## Inline color tags` block to
 *      the system prompt teaching the model the bracket syntax. Skipped
 *      when `PI_COLOR_TAGS_NO_PROMPT=1`.
 *
 *   2. `message_update` - mutate `event.message.content[i].text` (and
 *      `.thinking`) in place using `rewriteColorTags(text, resolver,
 *      { streaming: true })`. The same content array reference is held
 *      by pi's streamingComponent, so the mutation propagates to the
 *      live render.
 *
 * Pure helpers live under `../../../lib/node/pi/color-tags/` and don't
 * import from `@earendil-works/*`, so they're unit-testable under the
 * root vitest suite.
 *
 * Environment:
 *   PI_COLOR_TAGS_DISABLED=1   skip the extension entirely
 *   PI_COLOR_TAGS_NO_PROMPT=1  keep the rewriter, drop the system-prompt
 *                              addendum (A/B harness)
 *   PI_COLOR_TAGS_TRACE=<path> append per-event diagnostics to <path>
 *                              (default off; set to `off` to disable
 *                              explicitly)
 */

import { appendFileSync } from 'node:fs';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

import { appendColorPrompt, buildColorPromptAddendum } from '../../../lib/node/pi/color-tags/color-prompt.ts';
import { type ColorResolver, rewriteColorTags } from '../../../lib/node/pi/color-tags/parse-color-tags.ts';
import { CLOSE_FG, resolveColor } from '../../../lib/node/pi/color-tags/resolve-color.ts';
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

// ──────────────────────────────────────────────────────────────────────
// Helpers
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
 * Mutate text / thinking content parts in `message` in place. Returns
 * void - pi reads the same content array reference from
 * `event.message.content` during render, so an in-place mutation is
 * what makes the colors show up live.
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

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function colorTags(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COLOR_TAGS_DISABLED)) return;

  const promptDisabled = envTruthy(process.env.PI_COLOR_TAGS_NO_PROMPT);

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
    const resolver = buildResolver(ctx.ui.theme);
    // Optional per-event trace: snapshot before/after to disk so a debug
    // session can confirm whether the model emitted tags and whether the
    // rewriter changed anything. Default off; set PI_COLOR_TAGS_TRACE to
    // a writable path to enable.
    const tracePath = process.env.PI_COLOR_TAGS_TRACE;
    const traceEnabled = typeof tracePath === 'string' && tracePath.length > 0 && tracePath !== 'off';
    let beforeSnapshot = '';
    if (traceEnabled && Array.isArray(message.content)) {
      beforeSnapshot = message.content
        .map((p) => {
          if (typeof p?.text === 'string') return `[text len=${p.text.length}] ${p.text.slice(-200)}`;
          if (typeof p?.thinking === 'string') return `[thinking len=${p.thinking.length}] ${p.thinking.slice(-120)}`;
          return `[${p?.type ?? '?'}]`;
        })
        .join(' || ');
    }
    applyToMessage(message, resolver);
    if (traceEnabled && Array.isArray(message.content)) {
      const afterSnapshot = message.content
        .map((p) => {
          if (typeof p?.text === 'string') return `[text len=${p.text.length}] ${p.text.slice(-200)}`;
          if (typeof p?.thinking === 'string') return `[thinking len=${p.thinking.length}] ${p.thinking.slice(-120)}`;
          return `[${p?.type ?? '?'}]`;
        })
        .join(' || ');
      const openCount = beforeSnapshot.split('«c:').length - 1;
      const closeCount = beforeSnapshot.split('«/c»').length - 1;
      const changed = afterSnapshot !== beforeSnapshot ? 'YES' : 'no';
      try {
        appendFileSync(
          tracePath,
          `${new Date().toISOString()} parts=${message.content.length} «c:openCount=${openCount} «/c»closeCount=${closeCount} mutationChangedText=${changed}\n  before: ${JSON.stringify(beforeSnapshot)}\n  after:  ${JSON.stringify(afterSnapshot)}\n`,
        );
      } catch {
        // swallow: trace is best-effort, never break the stream on log IO.
      }
    }
    return undefined;
  });
}
