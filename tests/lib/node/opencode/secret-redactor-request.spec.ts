/**
 * Tests for lib/node/opencode/secret-redactor-request.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  cloneWith,
  collectStrings,
  mapStrings,
  redactContentPart,
  redactMessage,
  redactModelRequest,
  redactSystemPart,
} from '../../../../lib/node/opencode/secret-redactor-request.ts';

const SECRET = 'S3CRET';
const redact = (text: string): string => text.replaceAll(SECRET, '[R]');

/** Stand-in for an Effect `Schema.Class` message instance. */
class FakeMessage {
  role: string;
  content: unknown;
  constructor(role: string, content: unknown) {
    this.role = role;
    this.content = content;
  }
}

describe('mapStrings / collectStrings', () => {
  test('rewrites nested strings, copying only changed paths', () => {
    const untouched = { keep: 'plain' };
    const input = { cmd: `echo ${SECRET}`, args: ['a', SECRET], nested: { deep: [{ v: SECRET }] }, untouched, n: 3 };
    const out = mapStrings(input, redact) as typeof input;
    expect(out).toEqual({ cmd: 'echo [R]', args: ['a', '[R]'], nested: { deep: [{ v: '[R]' }] }, untouched, n: 3 });
    expect(out.untouched).toBe(untouched);
    expect(input.cmd).toBe(`echo ${SECRET}`);
  });

  test('returns the same reference when nothing changes', () => {
    const input = { a: ['x', { b: 'y' }] };
    expect(mapStrings(input, redact)).toBe(input);
  });

  test('never rewrites object keys or class instances', () => {
    const bytes = new Uint8Array([1, 2]);
    const input = { [SECRET]: 'v', bytes };
    const out = mapStrings(input, redact) as Record<string, unknown>;
    expect(out).toBe(input);
    expect(out.bytes).toBe(bytes);
  });

  test('collectStrings walks arrays and plain objects', () => {
    expect(collectStrings({ a: 'x', b: ['y', { c: 'z' }], d: 1 })).toEqual(['x', 'y', 'z']);
  });
});

describe('cloneWith', () => {
  test('keeps the prototype of class instances', () => {
    const m = new FakeMessage('user', []);
    const c = cloneWith(m, { content: ['x'] });
    expect(c).toBeInstanceOf(FakeMessage);
    expect(c.content).toEqual(['x']);
    expect(m.content).toEqual([]);
  });
});

describe('redactContentPart', () => {
  test('text', () => {
    expect(redactContentPart({ type: 'text', text: `t ${SECRET}` }, redact)).toEqual({ type: 'text', text: 't [R]' });
  });

  test('unsigned reasoning is redacted; signed or encrypted reasoning passes through', () => {
    expect(redactContentPart({ type: 'reasoning', text: SECRET }, redact)).toEqual({ type: 'reasoning', text: '[R]' });
    const signed = { type: 'reasoning', text: SECRET, providerMetadata: { anthropic: { signature: 'sig' } } };
    expect(redactContentPart(signed, redact)).toBe(signed);
    const encrypted = { type: 'reasoning', text: SECRET, encrypted: 'blob' };
    expect(redactContentPart(encrypted, redact)).toBe(encrypted);
  });

  test('tool-call input is deep-walked', () => {
    const part = { type: 'tool-call', id: 'c1', name: 'shell', input: { command: `curl -H ${SECRET}`, env: [SECRET] } };
    expect(redactContentPart(part, redact)).toEqual({
      ...part,
      input: { command: 'curl -H [R]', env: ['[R]'] },
    });
  });

  test('tool-result json / text / error values and content text items', () => {
    for (const type of ['json', 'text', 'error']) {
      const part = { type: 'tool-result', id: 'c1', name: 'shell', result: { type, value: { out: SECRET } } };
      expect(redactContentPart(part, redact)).toEqual({ ...part, result: { type, value: { out: '[R]' } } });
    }
    const file = { type: 'file', uri: `data:text/plain,${SECRET}`, mime: 'text/plain' };
    const content = {
      type: 'tool-result',
      id: 'c2',
      name: 'read',
      result: { type: 'content', value: [{ type: 'text', text: SECRET }, file] },
    };
    const out = redactContentPart(content, redact) as typeof content;
    expect(out.result.value[0]).toEqual({ type: 'text', text: '[R]' });
    expect(out.result.value[1]).toBe(file);
  });

  test('compaction text is redacted unless encrypted', () => {
    expect(redactContentPart({ type: 'compaction', provider: 'p', text: SECRET }, redact)).toEqual({
      type: 'compaction',
      provider: 'p',
      text: '[R]',
    });
    const enc = { type: 'compaction', provider: 'p', encrypted: SECRET };
    expect(redactContentPart(enc, redact)).toBe(enc);
  });

  test('media, effort, and unknown parts pass through', () => {
    for (const part of [
      { type: 'media', media: { mediaType: 'image/png' }, filename: SECRET },
      { type: 'effort', effort: 'high' },
      { type: 'future', text: SECRET },
    ]) {
      expect(redactContentPart(part, redact)).toBe(part);
    }
  });
});

describe('redactMessage', () => {
  test('every role, string and array content, keeping prototype and identity of untouched parts', () => {
    const keep = { type: 'text', text: 'fine' };
    const msgs = [
      new FakeMessage('system', [{ type: 'text', text: SECRET }]),
      new FakeMessage('user', [keep, { type: 'text', text: SECRET }]),
      new FakeMessage('assistant', `said ${SECRET}`),
      new FakeMessage('tool', [{ type: 'tool-result', id: 'c', name: 'x', result: { type: 'text', value: SECRET } }]),
    ];
    const out = msgs.map((m) => redactMessage(m, redact) as FakeMessage);
    for (const [i, m] of out.entries()) {
      expect(m).toBeInstanceOf(FakeMessage);
      expect(m).not.toBe(msgs[i]);
      expect(JSON.stringify(m)).not.toContain(SECRET);
    }
    expect((out[1].content as unknown[])[0]).toBe(keep);
    expect(JSON.stringify(msgs)).toContain(SECRET); // originals untouched
  });

  test('unchanged message keeps identity', () => {
    const m = new FakeMessage('user', [{ type: 'text', text: 'hi' }]);
    expect(redactMessage(m, redact)).toBe(m);
  });
});

describe('redactSystemPart', () => {
  test('redacts text and the instructions mirror, including <context> entries', () => {
    const part = {
      type: 'text',
      text: `base\n<context key="deploy">${SECRET}</context>`,
      metadata: {
        other: 1,
        experimental: {
          instructions: [
            { key: 'core/date', text: 'today' },
            { key: 'context/deploy', text: SECRET },
          ],
        },
      },
    };
    const out = redactSystemPart(part, redact) as typeof part;
    expect(out.text).toBe('base\n<context key="deploy">[R]</context>');
    expect(out.metadata.experimental.instructions).toEqual([
      { key: 'core/date', text: 'today' },
      { key: 'context/deploy', text: '[R]' },
    ]);
    expect(out.metadata.other).toBe(1);
    expect(out.metadata.experimental.instructions[0]).toBe(part.metadata.experimental.instructions[0]);
    expect(part.text).toContain(SECRET);
  });
});

describe('redactModelRequest', () => {
  const build = (): { system: unknown[]; messages: unknown[] } => ({
    system: [
      { type: 'text', text: `sys ${SECRET}` },
      { type: 'text', text: 'clean' },
    ],
    messages: [
      new FakeMessage('user', [{ type: 'text', text: 'hello' }]),
      new FakeMessage('assistant', [{ type: 'tool-call', id: 'c', name: 'shell', input: { command: SECRET } }]),
    ],
  });

  test('replaces only changed entries and counts them', () => {
    const req = build();
    const [, clean] = req.system;
    const [first] = req.messages;
    expect(redactModelRequest(req, redact)).toBe(2);
    expect(req.system[1]).toBe(clean);
    expect(req.messages[0]).toBe(first);
    expect(JSON.stringify(req)).not.toContain(SECRET);
  });

  test('is deterministic across fresh copies (stable cache prefix)', () => {
    const a = build();
    const b = build();
    redactModelRequest(a, redact);
    redactModelRequest(b, redact);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('a clean request is left byte-identical', () => {
    const req = { system: [{ type: 'text', text: 'x' }], messages: [new FakeMessage('user', 'hi')] };
    const before = [...req.messages];
    expect(redactModelRequest(req, redact)).toBe(0);
    expect(req.messages).toEqual(before);
  });
});
