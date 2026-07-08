/**
 * Command-surface tests for the three context-edit extensions
 * (`context-trim`, `message-edit`, `tool-collapse`).
 *
 * The extension shells live under `config/pi/extensions/` and resolve
 * `@earendil-works/*` against pi's runtime, so they aren't imported here.
 * Instead we mirror the EXACT `completeSubverbs` spec object each command
 * registers (per `config/pi/extensions/AGENTS.md`) and assert level-1
 * completion plus a level-2 resolver - including that a deeper `value`
 * carries the verb prefix so the verb survives submission. The shared
 * directive engine they all drive is exercised end-to-end against the
 * same helpers the shells use.
 *
 * All code under test here is pure (no pi-runtime imports).
 */

import { describe, expect, test } from 'vitest';

import { applyDirectives } from '../../../../lib/node/pi/context-edit/apply.ts';
import { type CompletionCandidate, completeCandidatesOrVerbs } from '../../../../lib/node/pi/context-edit/complete.ts';
import { addCollapse, addEdit, addTrim, emptyState } from '../../../../lib/node/pi/context-edit/directive.ts';
import { enumerate } from '../../../../lib/node/pi/context-edit/enumerate.ts';
import type { LooseMessage } from '../../../../lib/node/pi/context-edit/target.ts';
import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { assertOk } from '../../../lib/node/pi/helpers.ts';

// Mirror of each command's registered subverb spec. The `restore`
// resolvers read live directive ids; we feed a fixed set so the test is
// deterministic.
const verbsFor = (noun: string, ids: number[]): SubverbSpec => ({
  list: { description: `Show active ${noun}s` },
  restore: { description: `Undo a ${noun} by #id`, args: () => ids.map((id) => ({ label: String(id) })) },
  clear: { description: `Undo all ${noun}s` },
});

describe('isHelpArg recognises the help tokens', () => {
  test.each(['help', '--help', '-h', '?'])('%s', (token) => {
    expect(isHelpArg(token)).toBe(true);
  });
  test('a real first token is not help', () => {
    expect(isHelpArg('img1')).toBe(false);
  });
});

// Each command registers completeCandidatesOrVerbs(prefix, candidates, verbs).
// The candidates come from a live snapshot the extension keeps fresh in its
// context hook; here we feed a fixed snapshot so the test is deterministic.
const candidates: CompletionCandidate[] = [
  { id: 'img1', description: 'image (24.7KB): 1 image from read' },
  { id: 'msg1', description: 'user msg (1L 65B): hello' },
];

describe('completion - level 1 offers candidate handles AND verbs', () => {
  test.each(['trim', 'edit', 'collapse'])('%s surfaces handles before verbs', (noun) => {
    const items = completeCandidatesOrVerbs('', candidates, verbsFor(noun, [1]));
    expect(items?.map((i) => i.value)).toEqual(['img1', 'msg1', 'list', 'restore', 'clear']);
  });

  test('the image handle is selectable with its size in the description', () => {
    const img = completeCandidatesOrVerbs('', candidates, verbsFor('trim', [1]))?.find((i) => i.value === 'img1');
    expect(img?.label).toBe('img1');
    expect(img?.description).toContain('24.7KB');
  });

  test('prefix filters across handles and verbs', () => {
    expect(completeCandidatesOrVerbs('img', candidates, verbsFor('trim', [1]))?.map((i) => i.value)).toEqual(['img1']);
    expect(completeCandidatesOrVerbs('re', candidates, verbsFor('trim', [1]))?.map((i) => i.value)).toEqual([
      'restore',
    ]);
  });
});

describe('completion - level 2 restore resolver carries the verb prefix', () => {
  test.each(['trim', 'edit', 'collapse'])('%s restore <id> value is "restore <id>"', (noun) => {
    const items = completeCandidatesOrVerbs('restore ', candidates, verbsFor(noun, [3, 7]));
    expect(items?.map((i) => i.value)).toEqual(['restore 3', 'restore 7']);
  });

  test('restore filters by the partial id', () => {
    expect(completeCandidatesOrVerbs('restore 7', candidates, verbsFor('trim', [3, 7]))?.map((i) => i.value)).toEqual([
      'restore 7',
    ]);
  });
});

// message-edit adds a `sort` verb (order|size) on top of the shared
// list/restore/clear. Its level-2 completion goes through the same
// `completeSubverbs` helper `completeCandidatesOrVerbs` delegates to, so
// the `sort <choice>` value carries the verb prefix just like `restore`.
describe('completion - message-edit sort verb carries the verb prefix', () => {
  const sortSpec: SubverbSpec = {
    sort: { description: 'List by message order or size', args: () => [{ label: 'order' }, { label: 'size' }] },
  };

  test('level 1 offers the sort verb', () => {
    expect(completeSubverbs('so', sortSpec)?.map((i) => i.value)).toEqual(['sort']);
  });

  test('level 2 completes both choices as "sort <choice>"', () => {
    expect(completeSubverbs('sort ', sortSpec)?.map((i) => i.value)).toEqual(['sort order', 'sort size']);
  });

  test('level 2 filters by the partial choice', () => {
    expect(completeSubverbs('sort s', sortSpec)?.map((i) => i.value)).toEqual(['sort size']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: the handle a listing shows resolves back to the content the
// directive overlays. This is the contract the command handlers rely on.
// ──────────────────────────────────────────────────────────────────────

const big = 'x'.repeat(5000);

describe('handle round-trip through enumerate + apply', () => {
  test('context-trim: a msg handle trims that exact message', () => {
    const messages: LooseMessage[] = [
      { role: 'user', content: 'keep me', timestamp: 1 },
      { role: 'user', content: big, timestamp: 2 },
    ];
    const cand = enumerate(messages).find((c) => c.kind === 'message' && c.bytes > 1000);
    expect(cand?.target).toBeDefined();
    const r = addTrim(emptyState(), cand!.target!, 'big', 1);
    assertOk(r);
    const out = applyDirectives(messages, r.state.directives);
    expect(out.applied).toBe(1);
    expect(out.messages[0].content).toBe('keep me'); // untouched
  });

  test('message-edit: an edit overlays the chosen message text', () => {
    const messages: LooseMessage[] = [{ role: 'assistant', content: 'draft', timestamp: 5 }];
    const cand = enumerate(messages, { minTextBytes: 1 }).find((c) => c.kind === 'message');
    const r = addEdit(emptyState(), cand!.target!, 'final', 'steering', 1);
    assertOk(r);
    const out = applyDirectives(messages, r.state.directives);
    const part = (out.messages[0].content as { type: string; text: string }[])[0];
    expect(part.text).toBe('final');
  });

  test('tool-collapse: a call handle collapses its result', () => {
    const messages: LooseMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'comfyui', arguments: { p: 'cat' } }],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'comfyui',
        content: [{ type: 'text', text: big }],
        timestamp: 2,
      },
    ];
    const cand = enumerate(messages).find((c) => c.toolCallId === 'c1');
    expect(cand?.toolCallId).toBe('c1');
    const r = addCollapse(emptyState(), cand!.toolCallId!, 'bg', 1);
    assertOk(r);
    const out = applyDirectives(messages, r.state.directives);
    expect(out.applied).toBe(1);
  });
});
