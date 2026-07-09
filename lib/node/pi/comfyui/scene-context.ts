/**
 * Recent-conversation capture for the `comfyui` prompt enhancer.
 *
 * The enhancer runs as a fresh one-shot subagent, so it never sees the
 * parent conversation (see `enhance.ts`). When `enhanceContextChars > 0`,
 * the extension snapshots a bounded slice of the most recent user /
 * assistant turns in its `context` hook and feeds it to the enhancer as
 * background scene context - continuity (lighting, setting, wardrobe,
 * mood) the calling model did not pack into the `context` arg. This lets
 * the enhancer enrich even an already-protocol-formatted prompt.
 *
 * Pure + duck-typed (no pi imports) so it is unit-testable: it accepts the
 * minimal `{ role, content }` shape the `context` hook's `event.messages`
 * satisfies.
 */

import { messageContentToText } from '../message-text.ts';

/** Minimal duck-typed content part - only `text` parts carry scene text. */
export interface SceneContentPart {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** Minimal duck-typed message - mirrors pi's resolved `Message` shape. */
export interface SceneMessage {
  role: string;
  content: string | SceneContentPart[];
}

const ROLE_LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant' };

/**
 * Strip ephemeral `<system-reminder …>…</system-reminder>` blocks that
 * other extensions' `context` hooks may have spliced into a turn, so they
 * never leak into the captured scene. Collapse whitespace to one line.
 */
function clean(text: string): string {
  return text
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a background scene blurb from the most recent user / assistant
 * turns, newest collected first then emitted in chronological order,
 * capped to `maxChars` total. Returns `''` when capture is off
 * (`maxChars <= 0`), there are no usable turns, or every recent turn is
 * empty (e.g. assistant tool-call-only messages). Never throws.
 *
 * Each kept turn is prefixed with a `User:` / `Assistant:` label.
 * Tool-result and system messages are skipped. A single most-recent turn
 * that alone exceeds the budget is tail-truncated (its newest text wins).
 */
export function extractSceneContext(messages: readonly SceneMessage[] | undefined, maxChars: number): string {
  if (messages === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return '';

  const collected: string[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const label = ROLE_LABEL[m.role];
    if (label === undefined) continue;
    const text = clean(messageContentToText(m.content));
    if (text.length === 0) continue;
    const line = `${label}: ${text}`;
    const addLen = line.length + (collected.length > 0 ? 1 : 0); // +1 for the join newline
    if (collected.length === 0 && line.length > maxChars) {
      collected.push(line.slice(line.length - maxChars));
      total = maxChars;
      break;
    }
    if (total + addLen > maxChars) break;
    collected.push(line);
    total += addLen;
  }

  return collected.reverse().join('\n');
}

/**
 * Merge the calling model's explicit `context` arg with the auto-captured
 * scene blurb into a single background string for the enhance task. The
 * explicit context leads (it is the deliberate, render-specific signal);
 * the captured scene follows under its own label. Either may be empty;
 * returns `undefined` when both are.
 */
export function mergeSceneContext(manual: string | undefined, captured: string | undefined): string | undefined {
  const parts: string[] = [];
  const m = manual?.trim();
  if (m !== undefined && m.length > 0) parts.push(m);
  const c = captured?.trim();
  if (c !== undefined && c.length > 0) parts.push(`Recent conversation (for continuity):\n${c}`);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
