/**
 * Tests for lib/node/pi/notify-once.ts.
 *
 * Pure module - the helper takes an injected `notify` so tests just
 * record calls into a local array.
 */

import { describe, expect, test } from 'vitest';

import { createNotifyOnce, type NotifyFn, type NotifySeverity } from '../../../../lib/node/pi/notify-once.ts';

interface Recorded {
  message: string;
  severity?: NotifySeverity;
}

function recorder(): { fn: NotifyFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn: NotifyFn = (message, severity) => {
    calls.push(severity === undefined ? { message } : { message, severity });
  };
  return { fn, calls };
}

describe('createNotifyOnce', () => {
  test('renders default message + severity', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({ tag: 'persona' });

    t.surface(fn, [{ source: '/path/a.json', reason: 'bad shape' }]);

    expect(calls).toEqual([{ message: 'persona: /path/a.json: bad shape', severity: 'warning' }]);
  });

  test('honors a custom severity', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({ tag: 'preset', severity: 'error' });

    t.surface(fn, [{ source: '/p.json', reason: 'parse fail' }]);

    expect(calls[0]?.severity).toBe('error');
  });

  test('dedups by source+reason key across calls', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({ tag: 'persona' });
    const w = { source: '/p.json', reason: 'bad' };

    t.surface(fn, [w, w]);
    t.surface(fn, [w]);

    expect(calls).toHaveLength(1);
    expect(t.size()).toBe(1);
  });

  test('different reasons from the same source notify separately', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({ tag: 'persona' });

    t.surface(fn, [
      { source: '/p.json', reason: 'r1' },
      { source: '/p.json', reason: 'r2' },
    ]);

    expect(calls).toHaveLength(2);
  });

  test('reset() re-arms previously seen warnings', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({ tag: 'persona' });
    const w = { source: '/p.json', reason: 'bad' };

    t.surface(fn, [w]);
    t.reset();
    t.surface(fn, [w]);

    expect(calls).toHaveLength(2);
    expect(t.size()).toBe(1);
  });

  test('custom keyOf widens the dedup key', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({
      tag: 'persona',
      keyOf: (w) => `${w.source}|${w.reason}`,
    });

    t.surface(fn, [
      { source: '/p.json', reason: 'r' },
      { source: '/p.json', reason: 'r' },
    ]);

    expect(calls).toHaveLength(1);
  });

  test('custom render formats the message differently', () => {
    const { fn, calls } = recorder();
    const t = createNotifyOnce({
      tag: 'preset',
      render: (w, tag) => `${tag}: ${w.source}: ${w.reason}!!`,
    });

    t.surface(fn, [{ source: '/p.json', reason: 'oops' }]);

    expect(calls[0]?.message).toBe('preset: /p.json: oops!!');
  });
});
