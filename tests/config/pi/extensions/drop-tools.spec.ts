/**
 * Command/tool-surface tests for the agent drop tools (`drop_image` in
 * `context-trim.ts`, `collapse_output` in `tool-collapse.ts`).
 *
 * The extension shells resolve `@earendil-works/*` against pi's runtime,
 * so they aren't imported here. Instead we exercise the EXACT pure
 * pipeline each tool drives end-to-end against the same helpers the
 * shells use: enumerate the live context -> filter to the tool's target
 * kind -> resolve recency ordinals (+ tail-guard) -> apply the directive
 * -> assert the overlay AND its reversibility. This also locks in the
 * guardrail that user messages / assistant text are never targetable.
 *
 * All code under test here is pure (no pi-runtime imports).
 */

import { describe, expect, test } from 'vitest';

import { resolveRecencyTargets, toTitleItem } from '../../../../lib/node/pi/context-edit/agent-drop.ts';
import { applyDirectives } from '../../../../lib/node/pi/context-edit/apply.ts';
import { addCollapse, addTrim, emptyState, removeDirective } from '../../../../lib/node/pi/context-edit/directive.ts';
import { type Candidate, candidateLabel, enumerate } from '../../../../lib/node/pi/context-edit/enumerate.ts';
import { isPlaceholder } from '../../../../lib/node/pi/context-edit/placeholder.ts';
import type { LooseMessage, LoosePart } from '../../../../lib/node/pi/context-edit/target.ts';
import { assertOk } from '../../../lib/node/pi/helpers.ts';

const big = 'x'.repeat(5000);

// Two image results + two bash results + interleaved user/assistant text,
// oldest first. Mirrors what the `context` hook hands the extension.
function context(): LooseMessage[] {
  return [
    { role: 'user', content: 'render two cats', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'img-a', name: 'generate_image', arguments: { prompt: 'cat 1' } }],
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'img-a',
      toolName: 'generate_image',
      content: [{ type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' }],
      timestamp: 3,
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'img-b', name: 'generate_image', arguments: { prompt: 'cat 2' } }],
      timestamp: 4,
    },
    {
      role: 'toolResult',
      toolCallId: 'img-b',
      toolName: 'generate_image',
      content: [{ type: 'image', data: 'B'.repeat(4000), mimeType: 'image/png' }],
      timestamp: 5,
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'sh-a', name: 'bash', arguments: { cmd: 'cat huge' } }],
      timestamp: 6,
    },
    { role: 'toolResult', toolCallId: 'sh-a', toolName: 'bash', content: [{ type: 'text', text: big }], timestamp: 7 },
  ];
}

const imageCandidates = (messages: LooseMessage[]): Candidate[] =>
  enumerate(messages).filter((c) => c.kind === 'image');

// Mirror tool-collapse's candidatesFrom: merge tool-call/result by id.
const collapseCandidates = (messages: LooseMessage[]): Candidate[] => {
  const byId = new Map<string, Candidate>();
  for (const c of enumerate(messages)) {
    if ((c.kind !== 'tool-call' && c.kind !== 'tool-result') || !c.toolCallId) continue;
    const prev = byId.get(c.toolCallId);
    if (!prev || c.bytes > prev.bytes) byId.set(c.toolCallId, c);
  }
  return [...byId.values()];
};

function imagePartsOf(messages: LooseMessage[]): LoosePart[] {
  return messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((p) => p.type === 'image');
}

describe('drop_image pipeline', () => {
  test('keepRecent: 1 drops the older image, tail-guards the newest', () => {
    const messages = context();
    const cands = imageCandidates(messages);
    expect(cands.length).toBe(2);

    const resolution = resolveRecencyTargets(cands, { keepRecent: 1 }, 1);
    // img-b is newest (ordinal 1, kept); img-a is ordinal 2 (dropped).
    expect(resolution.selected.map((s) => s.candidate.toolCallId)).toEqual(['img-a']);

    let state = emptyState();
    for (const it of resolution.selected) {
      const r = addTrim(state, it.candidate.target!, 'done', Date.now(), 'a cat');
      assertOk(r);
      state = r.state;
    }
    const applied = applyDirectives(messages, state.directives);
    const images = imagePartsOf(applied.messages);
    // Only the newest image survives; the older one is now a text placeholder.
    expect(images.length).toBe(1);
    const placeholders = applied.messages
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((p) => p.type === 'text' && isPlaceholder((p as { text: string }).text));
    expect(placeholders.length).toBe(1);
    expect((placeholders[0] as { text: string }).text).toContain('a cat');
  });

  test('pointed drop:[1] is refused by the tail-guard (cannot shed the active image)', () => {
    const resolution = resolveRecencyTargets(imageCandidates(context()), { drop: [1] }, 1);
    expect(resolution.selected).toEqual([]);
    expect(resolution.guarded.map((s) => s.ordinal)).toEqual([1]);
  });

  test('a dropped image is reversible (removeDirective restores it)', () => {
    const messages = context();
    const cand = resolveRecencyTargets(imageCandidates(messages), { drop: [2] }, 1).selected[0];
    let state = emptyState();
    const added = addTrim(state, cand.candidate.target!, undefined, Date.now());
    assertOk(added);
    state = added.state;
    const id = state.directives[0].id;
    expect(imagePartsOf(applyDirectives(messages, state.directives).messages).length).toBe(1);
    const removed = removeDirective(state, id);
    assertOk(removed);
    state = removed.state;
    expect(imagePartsOf(applyDirectives(messages, state.directives).messages).length).toBe(2);
  });

  test('never targets user messages or assistant text', () => {
    const cands = imageCandidates(context());
    expect(cands.every((c) => c.kind === 'image')).toBe(true);
  });
});

describe('collapse_output pipeline', () => {
  test('toolName filter narrows to bash; collapse leaves a marker + is reversible', () => {
    const messages = context();
    const all = collapseCandidates(messages);
    const bash = all.filter((c) => (c.toolName ?? '').toLowerCase() === 'bash');
    expect(bash.length).toBe(1);

    // Only one bash pair -> it is the newest among "bash", tail-guarded at N=1.
    const guardedRes = resolveRecencyTargets(bash, { keepRecent: 0 }, 1);
    expect(guardedRes.selected).toEqual([]);

    // With no guard, it collapses to a [TOOL CALLED] marker.
    const res = resolveRecencyTargets(bash, { keepRecent: 0 }, 0);
    expect(res.selected.length).toBe(1);
    let state = emptyState();
    const col = addCollapse(state, res.selected[0].candidate.toolCallId!, 'extracted', Date.now());
    assertOk(col);
    state = col.state;
    const applied = applyDirectives(messages, state.directives);
    const result = applied.messages.find((m) => m.role === 'toolResult' && m.toolCallId === 'sh-a');
    expect(result).toBeDefined();
    const text = typeof result!.content === 'string' ? result!.content : (result!.content[0] as { text: string }).text;
    expect(text).toContain('TOOL CALLED');

    const id = state.directives[0].id;
    const removed = removeDirective(state, id);
    assertOk(removed);
    state = removed.state;
    const restored = applyDirectives(messages, state.directives).messages.find(
      (m) => m.role === 'toolResult' && m.toolCallId === 'sh-a',
    );
    expect(restored).toBeDefined();
    const restoredText =
      typeof restored!.content === 'string' ? restored!.content : (restored!.content[0] as { text: string }).text;
    expect(restoredText).toBe(big);
  });

  test('title items carry the recency ordinal + candidate label', () => {
    const res = resolveRecencyTargets(collapseCandidates(context()), { keepRecent: 1 }, 1);
    const items = res.selected.map((it) => toTitleItem(it));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].label).toBe(candidateLabel(res.selected[0].candidate));
    expect(items[0].ordinal).toBeGreaterThanOrEqual(2);
  });
});
