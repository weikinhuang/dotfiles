/** Pure, full-body message-edit listings built from the unmodified session messages. */

import { fuzzyMatch } from '../fuzzy-match.ts';
import { extractContentText } from '../message-text.ts';
import { byteLen } from '../shared/bytes.ts';
import { isTextPart } from '../shared/guards.ts';
import { applyDirectives } from './apply.ts';
import type { ContextEditState, EditDirective } from './directive.ts';
import { type LooseMessage, resolveTarget, type Target, targetKey, toParts } from './target.ts';

export interface MessageEditItem {
  id: string;
  key: string;
  target: Target;
  role: 'user' | 'assistant';
  original: string;
  text: string;
  editId?: number;
  /** Undo-only row: its target is absent or not a whole editable message. */
  stale: boolean;
  nonTextParts: number;
}

export type MessageEditRole = 'all' | 'user' | 'assistant';

/**
 * Assign msgN handles before applying overlays, keeping empty edits reachable
 * and handles unchanged by undo. Original text includes only text parts, with
 * exact whitespace and a newline between parts. Unrepresented edits remain as
 * undo-only editN rows; tool-result targets use assistant as the fallback role.
 */
export function buildMessageEditItems(
  messages: readonly LooseMessage[],
  state: ContextEditState,
  sort: 'order' | 'size' = 'order',
): MessageEditItem[] {
  const edits = state.directives.filter((d): d is EditDirective => d.kind === 'edit').sort((a, b) => a.id - b.id);
  const byTarget = new Map(edits.map((d) => [targetKey(d.target), d]));
  const current = applyDirectives(messages, state.directives);
  const staleIds = new Set(current.stale);
  const represented = new Set<number>();
  const occurrences = new Map<string, number>();
  const items: MessageEditItem[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 0;
    const occurrenceKey = `${message.role}:${timestamp}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const parts = toParts(message.content);
    if (!parts.some(isTextPart)) continue;

    const target: Target = { by: 'message', role: message.role, timestamp, occurrence };
    const key = targetKey(target);
    const edit = byTarget.get(key);
    if (edit) represented.add(edit.id);
    items.push({
      id: `msg${items.length + 1}`,
      key,
      target,
      role: message.role,
      original: extractContentText(message.content),
      text: edit && !staleIds.has(edit.id) ? edit.text : extractContentText(current.messages[i].content),
      ...(edit ? { editId: edit.id } : {}),
      stale: resolveTarget(messages, target) === null || (edit !== undefined && staleIds.has(edit.id)),
      nonTextParts: parts.filter((part) => !isTextPart(part)).length,
    });
  }

  for (const edit of edits) {
    if (represented.has(edit.id)) continue;
    const hit = resolveTarget(messages, edit.target);
    const parts = hit ? toParts(messages[hit.messageIndex].content) : [];
    const content = hit?.partIndex === undefined ? parts : parts.slice(hit.partIndex, hit.partIndex + 1);
    items.push({
      id: `edit${edit.id}`,
      key: targetKey(edit.target),
      target: { ...edit.target },
      role: edit.target.by === 'message' ? edit.target.role : 'assistant',
      original: extractContentText(content),
      text: edit.text,
      editId: edit.id,
      stale: true,
      nonTextParts: parts.filter((part) => !isTextPart(part)).length,
    });
  }

  if (sort === 'size') items.sort((a, b) => byteLen(b.text) - byteLen(a.text));
  return items;
}

/** Match every query word against full current/original bodies and the handle, without reranking. */
export function filterMessageEditItems(
  items: readonly MessageEditItem[],
  query: string,
  role: MessageEditRole = 'all',
  editedOnly = false,
): MessageEditItem[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (role !== 'all' && item.role !== role) return false;
    if (editedOnly && item.editId === undefined) return false;
    const body = `${item.id}\n${item.text}\n${item.original}`;
    return words.every((word) => fuzzyMatch(word, body) !== null);
  });
}

/** Parse a positive safe decimal directive id, optionally prefixed with #. */
export function parseEditId(input: string): number | null {
  const digits = input.startsWith('#') ? input.slice(1) : input;
  if (digits.length === 0 || /[^0-9]/.test(digits)) return null;
  const id = Number(digits);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
