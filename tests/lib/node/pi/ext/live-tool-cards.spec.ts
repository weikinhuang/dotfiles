import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LiveToolCards, type LiveCardRenderContext } from '../../../../../lib/node/pi/ext/live-tool-cards.ts';

type Context = Pick<LiveCardRenderContext, 'toolCallId' | 'state' | 'executionStarted' | 'isPartial' | 'invalidate'>;

function context(id = 'call-1', state: object = {}): Context {
  return { toolCallId: id, state, executionStarted: false, isPartial: true, invalidate: vi.fn() };
}

describe('LiveToolCards', () => {
  let cards: LiveToolCards<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cards = new LiveToolCards();
    cards.reset(true);
  });

  afterEach(() => {
    cards.reset();
    vi.useRealTimers();
  });

  test('updates a returned card on bounded ticks, then freezes its final view', () => {
    const row = context();
    let value = 'running';
    let active = true;
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value, active }));
    row.executionStarted = true;
    row.isPartial = false;
    expect(cards.read(row)).toBe('running');
    expect(vi.getTimerCount()).toBe(1);
    value = 'latest output';
    vi.advanceTimersByTime(499);
    expect(row.invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(row.invalidate).toHaveBeenCalledTimes(1);
    expect(cards.read(row)).toBe('latest output');
    value = 'completed';
    active = false;
    vi.advanceTimersByTime(500);
    expect(cards.read(row)).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
    value = 'removed';
    vi.advanceTimersByTime(5000);
    expect(cards.read(row)).toBe('completed');
    expect(row.invalidate).toHaveBeenCalledTimes(2);
  });

  test('shares one timer across parallel cards and snapshots before source removal', () => {
    const first = context('first');
    const second = context('second');
    let active = true;
    let value = 'running';
    for (const row of [first, second]) {
      cards.capture(row);
      cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value, active }));
      cards.read(row);
    }
    expect(vi.getTimerCount()).toBe(1);
    active = false;
    value = 'done';
    cards.refresh();
    expect(vi.getTimerCount()).toBe(0);
    expect(cards.read(first)).toBe('done');
    expect(cards.read(second)).toBe('done');
  });

  test('fresh export and replay states cannot attach or replace the live invalidator', () => {
    const row = context();
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value: 'live', active: true }));
    cards.read(row);
    const exported = { ...context(), executionStarted: true, isPartial: false };
    cards.capture(exported);
    expect(cards.read(exported)).toBeUndefined();
    const replay = { ...context(), isPartial: false };
    cards.capture(replay);
    expect(cards.read(replay)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(row.invalidate).toHaveBeenCalledTimes(1);
    expect(exported.invalidate).not.toHaveBeenCalled();
    expect(replay.invalidate).not.toHaveBeenCalled();
  });

  test.each(['print', 'rpc', 'json'] as const)('never activates in %s mode', (mode) => {
    const row = context();
    cards.capture(row);
    cards.bind(row.toolCallId, { mode }, () => ({ value: 'hidden', active: true }));
    expect(cards.read(row)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not activate without a captured pre-execution row', () => {
    const row = { ...context(), executionStarted: true };
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value: 'hidden', active: true }));
    expect(cards.read(row)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('paused watchers refresh on events without a timer and can resume', () => {
    const row = context();
    let active = false;
    let value = 'paused';
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value, active, watch: true }));
    expect(cards.read(row)).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
    active = true;
    value = 'enabled';
    cards.refresh();
    expect(cards.read(row)).toBe('enabled');
    expect(vi.getTimerCount()).toBe(1);
    active = false;
    value = 'paused again';
    cards.refresh();
    expect(cards.read(row)).toBe('paused again');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('shutdown cancels ticks and rejects late bindings, including reused IDs', () => {
    const row = context();
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value: 'old', active: true }));
    cards.read(row);
    cards.reset();
    cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value: 'late', active: true }));
    vi.advanceTimersByTime(5000);
    expect(row.invalidate).not.toHaveBeenCalled();
    expect(cards.read(row)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    cards.reset(true);
    const replacement = context();
    cards.capture(replacement);
    cards.bind(replacement.toolCallId, { mode: 'tui' }, () => ({ value: 'new', active: true }));
    expect(cards.read(replacement)).toBe('new');
    expect(cards.read(row)).toBeUndefined();
  });

  test('reset during invalidation prevents the remaining detached rows from refreshing', () => {
    const first = context('first');
    const second = context('second');
    first.invalidate = vi.fn(() => cards.reset());
    for (const row of [first, second]) {
      cards.capture(row);
      cards.bind(row.toolCallId, { mode: 'tui' }, () => ({ value: 'running', active: true }));
      cards.read(row);
    }
    cards.refresh();
    expect(first.invalidate).toHaveBeenCalledTimes(1);
    expect(second.invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('disappearing sources and detached UI freeze safely without leaking a timer', () => {
    const row = context();
    let exists = true;
    cards.capture(row);
    cards.bind(row.toolCallId, { mode: 'tui' }, () => {
      if (!exists) throw new Error('disposed source');
      return { value: 'last known state', active: true };
    });
    cards.read(row);
    exists = false;
    expect(() => cards.refresh()).not.toThrow();
    expect(cards.read(row)).toBe('last known state');
    expect(vi.getTimerCount()).toBe(0);
    const detached = context('detached');
    detached.invalidate = (): never => {
      throw new Error('detached UI');
    };
    cards.capture(detached);
    cards.bind(detached.toolCallId, { mode: 'tui' }, () => ({ value: 'safe', active: true }));
    cards.read(detached);
    expect(() => cards.refresh()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
