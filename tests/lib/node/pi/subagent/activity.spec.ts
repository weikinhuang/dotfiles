/**
 * Tests for lib/node/pi/subagent/activity.ts.
 *
 * Pure module - no pi runtime required. Covers:
 *   - formatActivityLine across the event types in the §3 mock table
 *   - streaming message_update cursor behaviour
 *   - ActivityRing eviction + freeze / resume
 *   - tailJsonl reduction of an on-disk transcript with an injected reader
 *   - getSessionActivityRings singleton stability
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  __resetSessionActivityRingsForTests,
  ActivityRing,
  type ActivityEvent,
  activityPushModeFor,
  applyActivityLine,
  formatActivityLine,
  getSessionActivityRings,
  makeActivityState,
  tailJsonl,
} from '../../../../../lib/node/pi/subagent/activity.ts';

describe('formatActivityLine', () => {
  test('turn_start emits a turn N counter', () => {
    const state = makeActivityState();

    expect(formatActivityLine({ type: 'turn_start' }, state)).toBe('turn 1');
    expect(formatActivityLine({ type: 'turn_start' }, state)).toBe('turn 2');
  });

  test('tool_execution_start summarises path / pattern / command args', () => {
    const state = makeActivityState();

    expect(
      formatActivityLine({ type: 'tool_execution_start', toolName: 'read', args: { path: 'foo.ts' } }, state),
    ).toBe('→ read  foo.ts');
    expect(
      formatActivityLine({ type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'formatJobLine' } }, state),
    ).toBe('→ grep  formatJobLine');
    expect(
      formatActivityLine({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls -la' } }, state),
    ).toBe('→ bash  ls -la');
  });

  test('tool_execution_end renders chars / count / error', () => {
    const state = makeActivityState();

    expect(formatActivityLine({ type: 'tool_execution_end', toolName: 'read', result: 'x'.repeat(1840) }, state)).toBe(
      '← 1840 chars',
    );
    expect(formatActivityLine({ type: 'tool_execution_end', toolName: 'grep', result: ['a', 'b', 'c'] }, state)).toBe(
      '← 3 items',
    );
    expect(
      formatActivityLine({ type: 'tool_execution_end', toolName: 'bash', result: 'denied', isError: true }, state),
    ).toBe('← error: denied');
  });

  test('message_update keeps the cursor and accumulates deltas', () => {
    const state = makeActivityState();
    const a = formatActivityLine(
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      },
      state,
    );
    const b = formatActivityLine(
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: ' world' },
      },
      state,
    );

    expect(a).toBe('▌ Hello');
    expect(b).toBe('▌ Hello world');
  });

  test('message_end on assistant emits the final text without cursor and resets state', () => {
    const state = makeActivityState();
    formatActivityLine(
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: 'final answer' },
      },
      state,
    );
    const end = formatActivityLine(
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      },
      state,
    );

    expect(end).toBe('final answer');
    expect(state.streaming).toBe(false);
    expect(state.streamingText).toBe('');
  });

  test('non-assistant message events are skipped', () => {
    const state = makeActivityState();

    expect(formatActivityLine({ type: 'message_update', message: { role: 'user' } }, state)).toBeNull();
    expect(formatActivityLine({ type: 'message_end', message: { role: 'user' } }, state)).toBeNull();
  });

  test('compaction_start / _end render a one-liner', () => {
    const s = makeActivityState();

    expect(formatActivityLine({ type: 'compaction_start', reason: 'threshold' }, s)).toBe('compact: threshold');
    expect(formatActivityLine({ type: 'compaction_end' }, s)).toBe('compact: done');
    expect(formatActivityLine({ type: 'compaction_end', errorMessage: 'overflow' }, s)).toContain('failed');
  });

  test('auto_retry_start / _end render a one-liner', () => {
    const s = makeActivityState();

    expect(formatActivityLine({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5 }, s)).toBe('retry 2/5');
    expect(formatActivityLine({ type: 'auto_retry_end' }, s)).toBe('retry: ok');
    expect(formatActivityLine({ type: 'auto_retry_end', errorMessage: '503' }, s)).toContain('failed');
  });

  test('skipped event types return null', () => {
    const s = makeActivityState();

    expect(formatActivityLine({ type: 'agent_start' }, s)).toBeNull();
    expect(formatActivityLine({ type: 'queue_update' }, s)).toBeNull();
    expect(formatActivityLine({ type: 'message_start', message: { role: 'assistant' } }, s)).toBeNull();
  });

  test('turn_start resets any half-finished streaming chain', () => {
    const s = makeActivityState();
    formatActivityLine(
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: 'half' },
      },
      s,
    );
    expect(s.streaming).toBe(true);

    formatActivityLine({ type: 'turn_start' }, s);
    expect(s.streaming).toBe(false);
    expect(s.streamingText).toBe('');
  });
});

describe('ActivityRing', () => {
  test('evicts oldest entries when over capacity', () => {
    const ring = new ActivityRing({ capacity: 3 });
    ring.push('a');
    ring.push('b');
    ring.push('c');
    ring.push('d');

    expect(ring.snapshot()).toEqual(['b', 'c', 'd']);
    expect(ring.size()).toBe(3);
  });

  test('freeze blocks new entries until resume', () => {
    const ring = new ActivityRing({ capacity: 8 });
    ring.push('a');
    ring.freeze();
    ring.push('b');

    expect(ring.snapshot()).toEqual(['a']);
    expect(ring.isFrozen()).toBe(true);

    ring.resume();
    ring.push('c');

    expect(ring.snapshot()).toEqual(['a', 'c']);
  });

  test('extend pushes multiple lines respecting capacity', () => {
    const ring = new ActivityRing({ capacity: 3 });
    ring.extend(['1', '2', '3', '4']);

    expect(ring.snapshot()).toEqual(['2', '3', '4']);
  });

  test('snapshot returns a copy', () => {
    const ring = new ActivityRing();
    ring.push('a');
    const snap = ring.snapshot();
    snap.push('b');

    expect(ring.snapshot()).toEqual(['a']);
  });

  test('clear empties the ring', () => {
    const ring = new ActivityRing();
    ring.push('a');
    ring.push('b');
    ring.clear();

    expect(ring.size()).toBe(0);
  });

  test('pushStreaming replaces the previous streaming entry in place', () => {
    const ring = new ActivityRing();
    ring.push('turn 1');
    ring.pushStreaming('▌ I');
    ring.pushStreaming('▌ I am');
    ring.pushStreaming('▌ I am streaming');

    expect(ring.snapshot()).toEqual(['turn 1', '▌ I am streaming']);
  });

  test('pushStreamingFinal commits the cursor line and the next push appends', () => {
    const ring = new ActivityRing();
    ring.pushStreaming('▌ hello');
    ring.pushStreamingFinal('hello world');
    ring.push('next');

    expect(ring.snapshot()).toEqual(['hello world', 'next']);
  });

  test('a regular push between streaming chains resets the replace flag', () => {
    const ring = new ActivityRing();
    ring.pushStreaming('▌ a');
    ring.push('turn 2');
    ring.pushStreaming('▌ b');

    expect(ring.snapshot()).toEqual(['▌ a', 'turn 2', '▌ b']);
  });

  test('clear also resets the streaming flag', () => {
    const ring = new ActivityRing();
    ring.pushStreaming('▌ a');
    ring.clear();
    ring.pushStreaming('▌ b');

    expect(ring.snapshot()).toEqual(['▌ b']);
  });
});

describe('activityPushModeFor', () => {
  test('assistant message_update is streaming, non-assistant is append', () => {
    expect(activityPushModeFor({ type: 'message_update', message: { role: 'assistant' } })).toBe('streaming');
    expect(activityPushModeFor({ type: 'message_update', message: { role: 'user' } })).toBe('append');
  });

  test('assistant message_end is streaming-final', () => {
    expect(activityPushModeFor({ type: 'message_end', message: { role: 'assistant' } })).toBe('streaming-final');
  });

  test('everything else appends', () => {
    expect(activityPushModeFor({ type: 'turn_start' })).toBe('append');
    expect(activityPushModeFor({ type: 'tool_execution_start' })).toBe('append');
  });
});

describe('applyActivityLine integration', () => {
  test('a token-by-token stream collapses to one row in the ring', () => {
    const ring = new ActivityRing();
    const state = makeActivityState();
    const events: ActivityEvent[] = [
      { type: 'turn_start' },
      ...["I'm", ' not', ' seeing', ' the', ' full', ' content'].map((d) => ({
        type: 'message_update',
        message: { role: 'assistant' as const },
        assistantMessageEvent: { type: 'text_delta', delta: d },
      })),
    ];
    for (const e of events) {
      const line = formatActivityLine(e, state);
      if (line) applyActivityLine(ring, line, activityPushModeFor(e));
    }

    expect(ring.snapshot()).toEqual(['turn 1', "▌ I'm not seeing the full content"]);
  });

  test('message_end on assistant replaces the cursor line with a static one', () => {
    const ring = new ActivityRing();
    const state = makeActivityState();
    const stream: ActivityEvent[] = [
      {
        type: 'message_update',
        message: { role: 'assistant' as const },
        assistantMessageEvent: { type: 'text_delta', delta: 'final' },
      },
      {
        type: 'message_update',
        message: { role: 'assistant' as const },
        assistantMessageEvent: { type: 'text_delta', delta: ' answer' },
      },
      {
        type: 'message_end',
        message: { role: 'assistant' as const, content: [{ type: 'text', text: 'final answer' }] },
      },
    ];
    for (const e of stream) {
      const line = formatActivityLine(e, state);
      if (line) applyActivityLine(ring, line, activityPushModeFor(e));
    }

    expect(ring.snapshot()).toEqual(['final answer']);
  });
});

describe('tailJsonl', () => {
  function fixture(events: ActivityEvent[]): string {
    return events.map((e) => JSON.stringify(e)).join('\n');
  }

  test('reduces a transcript to activity lines, last N', () => {
    const transcript = fixture([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_execution_end', toolName: 'read', result: 'xxxxx' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'foo' } },
      { type: 'tool_execution_end', toolName: 'grep', result: ['hit'] },
    ]);
    const out = tailJsonl('/fake/path.jsonl', { readFile: () => transcript });

    expect(out).toEqual(['turn 1', '→ read  a.ts', '← 5 chars', 'turn 2', '→ grep  foo', '← 1 item']);
  });

  test('caps to maxLines from the tail', () => {
    const transcript = fixture(
      Array.from({ length: 50 }, (_, i) => ({
        type: 'tool_execution_start',
        toolName: `t${i}`,
        args: { path: `x${i}` },
      })),
    );
    const out = tailJsonl('/fake/path.jsonl', { readFile: () => transcript, maxLines: 5 });

    expect(out).toHaveLength(5);
    expect(out[out.length - 1]).toBe('→ t49  x49');
  });

  test('skips malformed lines without throwing', () => {
    const transcript = `{"type":"turn_start"}\nnot json\n{"type":"tool_execution_start","toolName":"read","args":{"path":"x"}}`;
    const out = tailJsonl('/fake/path.jsonl', { readFile: () => transcript });

    expect(out).toEqual(['turn 1', '→ read  x']);
  });

  test('streaming deltas collapse to one row in the disk-tail too', () => {
    const transcript = fixture([
      { type: 'turn_start' },
      ...['I', ' am', ' streaming'].map<ActivityEvent>((d) => ({
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: d },
      })),
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'I am streaming' }] } },
    ]);
    const out = tailJsonl('/fake/path.jsonl', { readFile: () => transcript });

    expect(out).toEqual(['turn 1', 'I am streaming']);
  });

  test('returns empty array on read failure', () => {
    const out = tailJsonl('/fake/path.jsonl', {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });

    expect(out).toEqual([]);
  });
});

describe('getSessionActivityRings', () => {
  afterEach(() => {
    __resetSessionActivityRingsForTests();
  });

  test('returns the same Map across calls', () => {
    const a = getSessionActivityRings();
    const b = getSessionActivityRings();

    expect(a).toBe(b);
  });

  test('entries written via one handle are visible through another', () => {
    const writer = getSessionActivityRings();
    const ring = new ActivityRing();
    ring.push('hello');
    writer.set('h1', ring);

    const reader = getSessionActivityRings();

    expect(reader.get('h1')?.snapshot()).toEqual(['hello']);
  });
});
