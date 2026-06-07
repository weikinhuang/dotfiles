/**
 * The single overlay pass shared by all three context-edit extensions.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * `applyDirectives` takes the LLM message list (the `context` hook's deep
 * copy) and a directive set, and returns a NEW list with the overlay
 * applied. It mutates only the copies it builds - the input array and its
 * messages are treated as read-only - so the caller can pass pi's
 * `event.messages` straight through and return the result.
 *
 * Each kind:
 *   - trim     -> replace the targeted content part with a placeholder
 *                 (image part becomes a text part; oversized text part
 *                 becomes a short text part).
 *   - edit     -> replace the targeted message's text. Whole-message
 *                 edits collapse the message to a single text part;
 *                 part-scoped edits replace just that text part.
 *   - collapse -> blank the tool call's arguments AND replace its paired
 *                 tool-result content with a marker, keeping the
 *                 call/result pairing valid for the provider.
 *
 * A directive whose target no longer resolves is skipped and reported in
 * `stale` so the command layer can surface it. The applied count lets the
 * caller decide whether to return a changed list at all.
 */

import { type CollapseDirective, type Directive, type EditDirective, type TrimDirective } from './directive.ts';
import { collapsePlaceholder, imagePlaceholder, textPlaceholder } from './placeholder.ts';
import { findToolCall, type LooseMessage, type LoosePart, resolveTarget, type Target, toParts } from './target.ts';

export interface ApplyResult {
  messages: LooseMessage[];
  /** Number of directives that resolved and were applied. */
  applied: number;
  /** ids of directives whose target no longer resolved this turn. */
  stale: number[];
}

/** Shallow-copy each part of a content array without aliasing the input. */
function copyParts(parts: readonly LoosePart[]): LoosePart[] {
  const out: LoosePart[] = [];
  for (const p of parts) out.push({ ...p });
  return out;
}

/** Shallow-copy a message so we can replace its `content` without aliasing the input. */
function copyMessage(m: LooseMessage): LooseMessage {
  return { ...m, content: typeof m.content === 'string' ? m.content : copyParts(toParts(m.content)) };
}

function partText(part: LoosePart): string {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text
    : '';
}

function approxImageBytes(part: LoosePart): number {
  const data = (part as { data?: unknown }).data;
  // base64 expands ~4/3; estimate the decoded size for the annotation.
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
}

/** Pull a positive numeric `width` / `height` off an image part, when pi attached one. */
function imageDimension(part: LoosePart, key: 'width' | 'height'): number | undefined {
  const v = (part as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function applyTrim(messages: LooseMessage[], d: TrimDirective): boolean {
  const hit = resolveTarget(messages, d.target);
  if (!hit) return false;
  const msg = messages[hit.messageIndex];
  const parts = copyParts(toParts(msg.content));

  const replacePart = (idx: number): boolean => {
    const part = parts[idx];
    if (!part) return false;
    const text =
      part.type === 'image'
        ? imagePlaceholder({
            reason: d.reason,
            approxBytes: approxImageBytes(part),
            // Persisted once at creation time - never recomputed here.
            description: d.description,
            width: imageDimension(part, 'width'),
            height: imageDimension(part, 'height'),
          })
        : textPlaceholder(partText(part), d.reason);
    parts[idx] = { type: 'text', text };
    return true;
  };

  let changed = false;
  if (hit.partIndex !== undefined) {
    changed = replacePart(hit.partIndex);
  } else {
    // Whole-message trim: trim every part.
    for (let i = 0; i < parts.length; i++) changed = replacePart(i) || changed;
  }
  if (!changed) return false;
  messages[hit.messageIndex] = { ...msg, content: parts };
  return true;
}

function applyEdit(messages: LooseMessage[], d: EditDirective): boolean {
  const hit = resolveTarget(messages, d.target);
  if (!hit) return false;
  const msg = messages[hit.messageIndex];

  if (hit.partIndex === undefined) {
    // Replace the whole message with a single edited text part.
    messages[hit.messageIndex] = { ...msg, content: [{ type: 'text', text: d.text }] };
    return true;
  }
  const parts = copyParts(toParts(msg.content));
  const part = parts[hit.partIndex];
  if (part?.type !== 'text') return false;
  parts[hit.partIndex] = { ...part, text: d.text };
  messages[hit.messageIndex] = { ...msg, content: parts };
  return true;
}

function applyCollapse(messages: LooseMessage[], d: CollapseDirective): boolean {
  let changed = false;

  // 1. Blank the call's arguments so the bulky input doesn't linger,
  //    but keep the toolCall part present so the result stays paired.
  const call = findToolCall(messages, d.toolCallId);
  let toolName: string | undefined;
  if (call) {
    const msg = messages[call.messageIndex];
    const parts = copyParts(toParts(msg.content));
    const part = parts[call.partIndex] as { name?: string; arguments?: unknown };
    toolName = typeof part.name === 'string' ? part.name : undefined;
    part.arguments = {};
    messages[call.messageIndex] = { ...msg, content: parts };
    changed = true;
  }

  // 2. Replace the result content with the marker.
  const resultTarget: Target = { by: 'toolCallId', toolCallId: d.toolCallId };
  const hit = resolveTarget(messages, resultTarget);
  if (hit) {
    const msg = messages[hit.messageIndex];
    toolName ??= typeof msg.toolName === 'string' ? msg.toolName : undefined;
    messages[hit.messageIndex] = {
      ...msg,
      content: [{ type: 'text', text: collapsePlaceholder(toolName, d.reason) }],
    };
    changed = true;
  }
  return changed;
}

function applyOne(messages: LooseMessage[], d: Directive): boolean {
  switch (d.kind) {
    case 'trim':
      return applyTrim(messages, d);
    case 'edit':
      return applyEdit(messages, d);
    case 'collapse':
      return applyCollapse(messages, d);
  }
}

/**
 * Apply `directives` to a copy of `messages`. Directives apply in id
 * order (creation order) so a later edit on the same target wins
 * deterministically. Returns the new list plus bookkeeping.
 */
export function applyDirectives(messages: readonly LooseMessage[], directives: readonly Directive[]): ApplyResult {
  const out = messages.map(copyMessage);
  let applied = 0;
  const stale: number[] = [];

  const ordered = [...directives].sort((a, b) => a.id - b.id);
  for (const d of ordered) {
    if (applyOne(out, d)) applied++;
    else stale.push(d.id);
  }
  return { messages: out, applied, stale };
}
