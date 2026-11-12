/**
 * Tests for lib/node/opencode/context-edit.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  addCollapse,
  addTrim,
  type ContextEditState,
  emptyState,
} from '../../../../lib/node/pi/context-edit/directive.ts';
import {
  applyOverlay,
  applySelection,
  buildCandidates,
  buildListOutput,
  candidateKey,
  COLLAPSE_KEEP_INPUT_BYTES,
  CONTEXT_EDIT_MARKER,
  describeDirectives,
  describeProjection,
  dropReply,
  type OcMessage,
  type OcPart,
  parseDropInput,
  parseListOutput,
  parseResultMessage,
  parseRpcRequest,
  parseStoredState,
  planDrop,
  recordsFromLlmMessages,
  recordsFromSessionMessages,
  resolveContextEditConfig,
  restoreDirectives,
} from '../../../../lib/node/opencode/context-edit.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures: one conversation in both opencode shapes
// ──────────────────────────────────────────────────────────────────────

const BIG = Array.from({ length: 200 }, (_, i) => `line-${i} ${'x'.repeat(20)}`).join('\n');
const PNG_B64 = 'iVBORw0KGgo'.repeat(40);
const PNG_URI = `data:image/png;base64,${PNG_B64}`;
const LONG_INPUT = { command: 'y'.repeat(COLLAPSE_KEEP_INPUT_BYTES + 10) };

function call(id: string, name: string, input: unknown): OcPart {
  return { type: 'tool-call', id, name, input };
}

function toolMessage(id: string, name: string, result: unknown): OcMessage {
  return { role: 'tool', content: [{ type: 'tool-result', id, name, result }] };
}

function media(mime: string): OcPart {
  return {
    type: 'media',
    media: { mediaType: mime, source: { type: 'base64', data: PNG_B64, mediaType: mime } },
    filename: 'shot.png',
  };
}

/** LLM messages as the `context` hook sees them. */
function llmMessages(): OcMessage[] {
  return [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    {
      role: 'user',
      id: 'msg_u1',
      content: [{ type: 'text', text: 'look' }, media('application/pdf'), media('image/png')],
    },
    {
      role: 'assistant',
      id: 'msg_a1',
      content: [
        { type: 'text', text: 'running' },
        call('call_big', 'shell', { command: 'seq 200' }),
        call('call_img', 'read', { path: 'a.png' }),
        call('call_long', 'shell', LONG_INPUT),
      ],
    },
    toolMessage('call_big', 'shell', { type: 'text', value: BIG }),
    toolMessage('call_img', 'read', {
      type: 'content',
      value: [
        { type: 'text', text: 'Image read successfully' },
        { type: 'file', uri: PNG_URI, mime: 'image/png', name: 'a.png' },
        { type: 'file', uri: PNG_URI, mime: 'image/png', name: 'b.png' },
      ],
    }),
    toolMessage('call_long', 'shell', {
      type: 'error',
      value: { error: 'boom', content: [{ type: 'text', text: BIG }] },
    }),
    { role: 'assistant', id: 'msg_a2', content: [call('call_self', 'collapse_output', { drop: [2] })] },
    toolMessage('call_self', 'collapse_output', { type: 'text', value: 'Collapsed 1' }),
  ];
}

/** The same conversation as `ctx.session.context` returns it. */
function sessionMessages(): unknown[] {
  const tool = (id: string, name: string, input: unknown, content: unknown[], status = 'completed'): unknown => ({
    type: 'tool',
    id,
    name,
    state: { status, input, content },
  });
  return [
    {
      id: 'msg_u1',
      type: 'user',
      text: 'look',
      files: [
        { mime: 'application/pdf', data: PNG_B64, source: { type: 'inline' } },
        { mime: 'image/png', data: PNG_B64, name: 'shot.png', source: { type: 'inline' } },
        { mime: 'text/plain', data: 'aGk=', source: { type: 'inline' } },
      ],
    },
    {
      id: 'msg_a1',
      type: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        tool('call_big', 'shell', { command: 'seq 200' }, [{ type: 'text', text: BIG }]),
        tool('call_img', 'read', { path: 'a.png' }, [
          { type: 'text', text: 'Image read successfully' },
          { type: 'file', uri: PNG_URI, mime: 'image/png', name: 'a.png' },
          { type: 'file', uri: PNG_URI, mime: 'image/png', name: 'b.png' },
        ]),
        tool('call_long', 'shell', LONG_INPUT, [{ type: 'text', text: BIG }], 'error'),
        tool('call_running', 'shell', {}, [], 'running'),
        {
          type: 'tool',
          id: 'call_hosted',
          name: 'web',
          executed: true,
          state: { status: 'completed', input: {}, content: [] },
        },
      ],
    },
    {
      id: 'msg_a2',
      type: 'assistant',
      content: [tool('call_self', 'collapse_output', { drop: [2] }, [{ type: 'text', text: 'Collapsed 1' }])],
    },
    { id: 'msg_x', type: 'synthetic', text: 'note' },
  ];
}

function keys(state: ContextEditState = emptyState()): string[] {
  const set = buildCandidates(recordsFromSessionMessages(sessionMessages()), state);
  return [...set.tools, ...set.images].map(candidateKey).sort();
}

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────

describe('resolveContextEditConfig', () => {
  test('defaults', () => {
    expect(resolveContextEditConfig(undefined, {})).toEqual({
      enabled: true,
      tools: true,
      minBytes: 2048,
      snippetChars: 80,
      tailGuard: 1,
      debugFile: undefined,
    });
  });
  test('env beats options', () => {
    const config = resolveContextEditConfig(
      { minBytes: 10, tools: false },
      { OPENCODE_CONTEXT_EDIT_MIN_BYTES: '20', OPENCODE_CONTEXT_EDIT_DEBUG_FILE: '/tmp/x' },
    );
    expect(config).toMatchObject({ minBytes: 20, tools: false, debugFile: '/tmp/x' });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Records and candidates
// ──────────────────────────────────────────────────────────────────────

describe('records', () => {
  test('session history and LLM messages address the same content', () => {
    const fromLlm = buildCandidates(recordsFromLlmMessages(llmMessages()));
    const fromSession = buildCandidates(recordsFromSessionMessages(sessionMessages()));
    const toKeys = (s: typeof fromLlm): string[] => [...s.tools, ...s.images].map(candidateKey);
    expect(toKeys(fromSession)).toEqual(toKeys(fromLlm));
    expect(fromSession.tools.map((c) => c.bytes)).toEqual(fromLlm.tools.map((c) => c.bytes));
  });

  test('skips running, provider-executed, and non-image attachments', () => {
    expect(keys()).toEqual([
      'collapse:call_big',
      'collapse:call_img',
      'collapse:call_long',
      'trim:mid:msg_u1:1',
      'trim:tc:call_img:1',
      'trim:tc:call_img:2',
    ]);
  });

  test('a user image keeps its media ordinal past a PDF', () => {
    const images = buildCandidates(recordsFromLlmMessages(llmMessages())).images;
    expect(images.find((c) => c.role === 'user')?.target).toEqual({
      by: 'messageId',
      messageId: 'msg_u1',
      partIndex: 1,
    });
  });
});

describe('buildCandidates', () => {
  test('heaviest first, own tools excluded, minBytes gate on tool pairs only', () => {
    const records = recordsFromLlmMessages(llmMessages());
    const { tools, images } = buildCandidates(records, emptyState(), { minBytes: 1000 });
    expect(tools.map((c) => c.toolCallId)).toEqual(['call_long', 'call_big']);
    expect(images).toHaveLength(3);
    expect(tools[0].bytes).toBeGreaterThanOrEqual(tools[1].bytes);
  });

  test('every candidate gets its own recency seq', () => {
    const { tools, images } = buildCandidates(recordsFromLlmMessages(llmMessages()));
    const seqs = [...tools, ...images].map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('skips content already collapsed or trimmed', () => {
    let state = emptyState();
    const c = addCollapse(state, 'call_img', undefined, 1);
    if (!c.ok) throw new Error(c.error);
    state = c.state;
    const t = addTrim(state, { by: 'messageId', messageId: 'msg_u1', partIndex: 1 }, undefined, 2);
    if (!t.ok) throw new Error(t.error);
    // Collapsing a pair removes its images too.
    expect(keys(t.state)).toEqual(['collapse:call_big', 'collapse:call_long']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Overlay
// ──────────────────────────────────────────────────────────────────────

function stateWith(...ops: ((s: ContextEditState) => ReturnType<typeof addCollapse>)[]): ContextEditState {
  let s = emptyState();
  for (const op of ops) {
    const r = op(s);
    if (!r.ok) throw new Error(r.error);
    s = r.state;
  }
  return s;
}

function partOf(messages: readonly OcMessage[], role: string, id: string): OcPart | undefined {
  for (const m of messages) {
    if (m.role !== role) continue;
    const hit = m.content.find((p) => p.id === id);
    if (hit) return hit;
  }
  return undefined;
}

describe('applyOverlay', () => {
  test('collapse keeps the call/result pair and a small input', () => {
    const input = llmMessages();
    const snapshot = JSON.stringify(input);
    const state = stateWith((s) => addCollapse(s, 'call_big', 'done', 1));
    const out = applyOverlay(input, state.directives);
    expect(out).toMatchObject({ applied: 1, stale: [] });
    expect(partOf(out.messages, 'assistant', 'call_big')).toMatchObject({
      type: 'tool-call',
      input: { command: 'seq 200' },
    });
    expect(partOf(out.messages, 'tool', 'call_big')).toEqual({
      type: 'tool-result',
      id: 'call_big',
      name: 'shell',
      result: {
        type: 'text',
        value: `${CONTEXT_EDIT_MARKER} [TOOL CALLED shell] - ran; output removed from context: done`,
      },
    });
    // Same number of messages and tool parts: the provider still sees one result per call.
    expect(out.messages.map((m) => m.content.length)).toEqual(input.map((m) => m.content.length));
    // Input untouched; unrelated messages keep identity.
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out.messages[1]).toBe(input[1]);
  });

  test('collapse blanks a large input and replaces an error result', () => {
    const state = stateWith((s) => addCollapse(s, 'call_long', undefined, 1));
    const out = applyOverlay(llmMessages(), state.directives);
    expect(partOf(out.messages, 'assistant', 'call_long')?.input).toEqual({});
    expect(partOf(out.messages, 'tool', 'call_long')?.result).toEqual({
      type: 'text',
      value: `${CONTEXT_EDIT_MARKER} [TOOL CALLED shell] - ran; output removed from context`,
    });
  });

  test('trims one tool-result image and a user attachment, with caption', () => {
    const state = stateWith(
      (s) => addTrim(s, { by: 'toolCallId', toolCallId: 'call_img', partIndex: 2 }, undefined, 1, 'a blue square'),
      (s) => addTrim(s, { by: 'messageId', messageId: 'msg_u1', partIndex: 1 }, 'done', 2),
    );
    const out = applyOverlay(llmMessages(), state.directives);
    expect(out.applied).toBe(2);
    const result = partOf(out.messages, 'tool', 'call_img')?.result as { value: OcPart[] };
    expect(result.value[1]).toMatchObject({ type: 'file', name: 'a.png' });
    expect(result.value[2]).toEqual({
      type: 'text',
      text: `${CONTEXT_EDIT_MARKER} [IMAGE REMOVED · ~330B · "a blue square"]`,
    });
    const user = out.messages[2 - 1];
    expect(user.content.map((p) => p.type)).toEqual(['text', 'media', 'text']);
    expect(user.content[2]).toEqual({ type: 'text', text: `${CONTEXT_EDIT_MARKER} [IMAGE REMOVED · ~330B] - done` });
  });

  test('missing or wrong-kind targets are silent no-ops reported as stale', () => {
    const state = stateWith(
      (s) => addCollapse(s, 'gone', undefined, 1),
      (s) => addTrim(s, { by: 'messageId', messageId: 'msg_u1', partIndex: 0 }, undefined, 2), // the PDF
      (s) => addTrim(s, { by: 'toolCallId', toolCallId: 'call_img', partIndex: 0 }, undefined, 3), // a text item
      (s) => addTrim(s, { by: 'toolCallId', toolCallId: 'call_img' }, undefined, 4), // whole result
    );
    const input = llmMessages();
    const out = applyOverlay(input, state.directives);
    expect(out).toMatchObject({ applied: 0, stale: [1, 2, 3, 4] });
    expect(out.messages.every((m, i) => m === input[i])).toBe(true);
  });

  test('a call without its result (or a provider-executed call) is not collapsed', () => {
    const messages: OcMessage[] = [
      {
        role: 'assistant',
        id: 'a',
        content: [call('c1', 'shell', {}), { ...call('c2', 'web', {}), providerExecuted: true }],
      },
      toolMessage('c2', 'web', { type: 'text', value: 'hosted' }),
    ];
    const state = stateWith(
      (s) => addCollapse(s, 'c1', undefined, 1),
      (s) => addCollapse(s, 'c2', undefined, 2),
    );
    expect(applyOverlay(messages, state.directives)).toMatchObject({ applied: 0, stale: [1, 2] });
  });

  test('renders byte-identical output on every request', () => {
    const state = stateWith(
      (s) => addCollapse(s, 'call_big', 'r', 1),
      (s) => addTrim(s, { by: 'toolCallId', toolCallId: 'call_img', partIndex: 1 }, undefined, 2, 'cap'),
    );
    const a = JSON.stringify(applyOverlay(llmMessages(), state.directives).messages);
    const b = JSON.stringify(applyOverlay(llmMessages(), [...state.directives].reverse()).messages);
    expect(a).toBe(b);
  });

  test('shrinks the projected payload', () => {
    const state = stateWith((s) => addCollapse(s, 'call_big', undefined, 1));
    const before = describeProjection(llmMessages());
    const after = describeProjection(applyOverlay(llmMessages(), state.directives).messages);
    expect(before.bytes - after.bytes).toBeGreaterThan(BIG.length - 200);
    expect(after.lines.some((l) => l.includes('[TOOL CALLED shell]'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Directive bookkeeping
// ──────────────────────────────────────────────────────────────────────

describe('applySelection / restore / describe', () => {
  const records = recordsFromSessionMessages(sessionMessages());

  test('adds labelled directives by key, reporting unknown keys', () => {
    const candidates = buildCandidates(records);
    const out = applySelection(emptyState(), candidates, ['collapse:call_big', 'trim:tc:call_img:1', 'collapse:nope'], {
      reason: 'r',
      description: '  a   red\nsquare ',
      now: 5,
    });
    expect(out.missing).toEqual(['collapse:nope']);
    expect(out.state.directives).toMatchObject([
      { kind: 'collapse', toolCallId: 'call_big', reason: 'r', createdAt: 5 },
      { kind: 'trim', target: { by: 'toolCallId', toolCallId: 'call_img', partIndex: 1 }, description: 'a red square' },
    ]);
    expect(out.state.directives[0]).toHaveProperty('label', expect.stringContaining('result shell'));
  });

  test('describeDirectives flags targets that left the history', () => {
    const state = stateWith(
      (s) => addCollapse(s, 'call_big', undefined, 1, 'big'),
      (s) => addCollapse(s, 'compacted', undefined, 2),
      (s) => addTrim(s, { by: 'messageId', messageId: 'msg_u1', partIndex: 1 }, undefined, 3, undefined, 'img'),
    );
    expect(describeDirectives(state, records)).toEqual([
      { id: 1, kind: 'collapse', label: 'big', stale: false },
      { id: 2, kind: 'collapse', label: 'tool call compacted', stale: true },
      { id: 3, kind: 'trim', label: 'img', stale: false },
    ]);
  });

  test('restoreDirectives by id or all', () => {
    const state = stateWith(
      (s) => addCollapse(s, 'a', undefined, 1),
      (s) => addCollapse(s, 'b', undefined, 2),
    );
    expect(restoreDirectives(state, [2, 9])).toMatchObject({ restored: [2], missing: [9] });
    const all = restoreDirectives(state);
    expect(all.state).toEqual({ directives: [], nextId: 3 });
  });

  test('parseStoredState falls back to empty on junk', () => {
    expect(parseStoredState({ nope: true })).toEqual(emptyState());
    expect(parseStoredState(undefined)).toEqual(emptyState());
  });
});

// ──────────────────────────────────────────────────────────────────────
// Model tools
// ──────────────────────────────────────────────────────────────────────

describe('parseDropInput', () => {
  test('accepts drop / keepRecent and the per-tool extras', () => {
    expect(parseDropInput({ drop: [2, 3], toolName: ' bash ', reason: 'done' }, ['toolName'])).toEqual({
      ok: true,
      value: { drop: [2, 3], toolName: 'bash', reason: 'done' },
    });
    expect(parseDropInput({ keepRecent: 0, summary: 'red' }, ['summary'])).toEqual({
      ok: true,
      value: { keepRecent: 0, summary: 'red' },
    });
  });

  test.each([
    [null, 'Input must be an object.'],
    [{}, 'Specify `drop`'],
    [{ drop: [] }, 'Specify `drop`'],
    [{ drop: [0] }, 'positive integers'],
    [{ drop: '2' }, 'positive integers'],
    [{ keepRecent: -1 }, 'non-negative integer'],
    [{ keepRecent: 1, reason: 3 }, '`reason` must be a string'],
    [{ keepRecent: 1, summary: 'x' }, 'Unknown field(s): summary'],
  ])('rejects %j', (raw, message) => {
    const r = parseDropInput(raw, ['toolName']);
    expect(r.ok ? 'accepted' : r.error).toContain(message);
  });
});

describe('planDrop', () => {
  const { tools, images } = buildCandidates(recordsFromLlmMessages(llmMessages()));
  const noun = { one: 'tool pair', many: 'tool pairs' };

  test('resolves recency ordinals with the tail-guard', () => {
    // keepRecent is clamped up to the guard, so the newest pair (call_long) stays.
    const batch = planDrop(tools, { keepRecent: 0 }, 1, noun);
    if (batch.kind !== 'confirm') throw new Error(batch.message);
    expect(batch.keys).toEqual(['collapse:call_img', 'collapse:call_big']);
    // An explicit ordinal inside the guard is refused and reported.
    const pointed = planDrop(tools, { drop: [1, 3] }, 1, noun);
    if (pointed.kind !== 'confirm') throw new Error(pointed.message);
    expect(pointed.resolution.guarded.map((r) => r.candidate.toolCallId)).toEqual(['call_long']);
    expect(dropReply('Collapsed', pointed, 1)).toMatch(/^Collapsed 1 \(#3\).*Protected: #1\./);
  });

  test('filters by toolName and explains empty plans', () => {
    expect(planDrop(tools, { drop: [1] }, 1, noun)).toMatchObject({ kind: 'none' });
    expect(planDrop(tools, { drop: [1] }, 1, noun)).toHaveProperty('message', expect.stringContaining('protected'));
    expect(planDrop(tools, { drop: [9] }, 0, noun)).toHaveProperty('message', expect.stringContaining('#9'));
    expect(planDrop(tools, { drop: [1] }, 0, { ...noun })).toMatchObject({ kind: 'confirm' });
    expect(planDrop(tools, { drop: [1], toolName: 'grep' }, 0, noun)).toHaveProperty(
      'message',
      'No tool pairs from "grep" in the current context.',
    );
    const read = planDrop(tools, { drop: [1], toolName: 'READ' }, 0, noun);
    expect(read.kind === 'confirm' && read.keys).toEqual(['collapse:call_img']);
  });

  test('images: distinct parts of one result are separate ordinals', () => {
    const plan = planDrop(images, { keepRecent: 1 }, 1, { one: 'image', many: 'images' });
    if (plan.kind !== 'confirm') throw new Error(plan.message);
    expect(plan.keys).toEqual(['trim:tc:call_img:1', 'trim:mid:msg_u1:1']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// RPC helpers
// ──────────────────────────────────────────────────────────────────────

describe('rpc helpers', () => {
  test('parseRpcRequest', () => {
    expect(parseRpcRequest({ sessionID: 's', keys: ['k'], reason: ' r ' })).toEqual({
      ok: true,
      value: { sessionID: 's', keys: ['k'], reason: 'r' },
    });
    expect(parseRpcRequest({ sessionID: '' }).ok).toBe(false);
    expect(parseRpcRequest({ sessionID: 's', ids: [1.5] }).ok).toBe(false);
    expect(parseRpcRequest({ sessionID: 's', keys: [1] }).ok).toBe(false);
  });

  test('list output round-trips through the TUI parser', () => {
    const records = recordsFromSessionMessages(sessionMessages());
    const state = stateWith((s) => addCollapse(s, 'call_big', undefined, 1, 'big'));
    const out = buildListOutput(records, state, { minBytes: 1000 });
    expect(out.candidates.map((c) => c.key)).toEqual([
      'collapse:call_long',
      'trim:mid:msg_u1:1',
      'trim:tc:call_img:1',
      'trim:tc:call_img:2',
    ]);
    expect(parseListOutput(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(parseListOutput({ candidates: [{ key: 1 }], directives: 'x' })).toEqual({ candidates: [], directives: [] });
    expect(parseResultMessage({ message: 'ok' })).toBe('ok');
    expect(parseResultMessage(null)).toBe('Done.');
  });
});
