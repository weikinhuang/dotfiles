import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { appendCacheTrace, cacheResponseTrace, createCacheTracer } from '../../../../lib/node/pi/cache-trace.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';

const identity = { provider: 'azure-openai-responses', model: 'fixture' };
const base: ReminderMessage[] = [{ role: 'user', content: 'PRIVATE prompt' }];
const extension: ReminderMessage[] = [
  { role: 'assistant', content: [{ type: 'text', text: 'tool call' }] },
  { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE result' }] },
];

test('no reminders: entire prior message prefix is unchanged as history grows', () => {
  const trace = createCacheTracer();
  trace({ messages: base }, identity);
  const record = trace({ messages: [...base, ...extension] }, identity);
  expect(record.commonMessagePrefix).toBe(1);
  expect(record.firstDivergentMessage).toBeNull();
});

test.each([
  ['stable body', 'PLAN', 'PLAN'],
  ['todo transition', 'pending', 'in_progress'],
  ['removed', 'PLAN', null],
  ['job progressing', 'running, bytes=10', 'running, bytes=20'],
  ['job exited', 'running', 'exited'],
] as const)('%s: ephemeral tail delivery rewrites historical message zero', (_name, before, after) => {
  const trace = createCacheTracer();
  const first = trace({ input: applyContextReminder(base, { id: 'todo-plan', body: before }) }, identity);
  const second = trace(
    { input: applyContextReminder([...base, ...extension], { id: 'todo-plan', body: after }) },
    identity,
  );
  expect(first.messages[0].reminderIds).toEqual(['todo-plan']);
  expect(second.firstDivergentMessage).toBe(0);
  expect(second.commonMessagePrefix).toBe(0);
  expect(second.messages[0].sha256).not.toBe(first.messages[0].sha256);
  expect(second.commonBytePrefix).toBeGreaterThan(0);
  expect(JSON.stringify(second)).not.toContain('PRIVATE');
});

test('two reminder producers are identified without recording their bodies', () => {
  const messages = applyContextReminder(applyContextReminder(base, { id: 'todo-plan', body: 'PRIVATE plan' }), {
    id: 'bg-bash',
    body: 'PRIVATE job',
  });
  const record = createCacheTracer()({ messages }, identity);
  expect(record.messages[0].reminderIds).toEqual(['bg-bash', 'todo-plan']);
  expect(JSON.stringify(record)).not.toContain('PRIVATE');
});

test('stable serialized payload with falling usage distinguishes eviction from mutation', () => {
  const trace = createCacheTracer();
  const payload = { input: base, tools: [{ description: 'PRIVATE schema' }] };
  const first = trace(payload, identity);
  const second = trace(payload, identity);
  expect(second.commonBytePrefix).toBe(first.bytes);
  expect(second.firstDivergentMessage).toBeNull();
  expect(cacheResponseTrace(2, { cacheRead: 0, cacheWrite: 123 })).toMatchObject({ cacheRead: 0, cacheWrite: 123 });
});

test('UTF-8 prefixes count bytes, not UTF-16 characters; identity changes reset comparison', () => {
  const trace = createCacheTracer();
  trace({ input: [{ role: 'user', content: '中a' }] }, identity);
  const next = trace({ input: [{ role: 'user', content: '中b' }] }, identity);
  expect(next.commonBytePrefix).toBe(Buffer.byteLength('{"input":[{"role":"user","content":"中'));
  expect(trace({ input: base }, { ...identity, model: 'other' }).commonBytePrefix).toBe(0);
});

test('numeric response allowlist and best-effort log never record extra response content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-cache-trace-'));
  try {
    const path = join(dir, 'trace.jsonl');
    appendCacheTrace(
      path,
      cacheResponseTrace(1, {
        cacheRead: 100,
        cacheWrite: 200,
        secret: 'PRIVATE',
        cost: { total: 0.2, secret: 'PRIVATE' },
      }),
    );
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
    expect(() => appendCacheTrace(join(dir, 'missing', 'trace'), {})).not.toThrow();
    expect(() => appendCacheTrace(undefined, {})).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
