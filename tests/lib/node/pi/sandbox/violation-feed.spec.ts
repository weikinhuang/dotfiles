/**
 * Tests for lib/node/pi/sandbox/violation-feed.ts.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  type AsrtViolationEvent,
  createViolationFeed,
  formatHostPort,
  hostOfHostPort,
  parseOutboundDeny,
  violationToRecord,
} from '../../../../../lib/node/pi/sandbox/violation-feed.ts';

describe('parseOutboundDeny', () => {
  test('parses ASRT proxy deny lines', () => {
    expect(parseOutboundDeny('deny network-outbound example.com:443 (user denied)')).toEqual({
      host: 'example.com',
      port: 443,
      reason: 'user denied',
    });
  });

  test('keeps IPv6 hosts whole (last colon is the port)', () => {
    expect(parseOutboundDeny('deny network-outbound ::1:8080 (host is not on the allow list)')).toEqual({
      host: '::1',
      port: 8080,
      reason: 'host is not on the allow list',
    });
    expect(parseOutboundDeny('deny network-outbound [::1]:8080 (x)')?.host).toBe('::1');
  });

  test('reasons may contain parentheses', () => {
    expect(parseOutboundDeny('deny network-outbound a.io:80 (user denied: use b (staging))')?.reason).toBe(
      'user denied: use b (staging)',
    );
  });

  test('ignores other violation lines', () => {
    expect(parseOutboundDeny('deny file-write-create /etc/passwd')).toBeUndefined();
    expect(parseOutboundDeny('')).toBeUndefined();
  });
});

describe('formatHostPort / hostOfHostPort', () => {
  test('round-trips names, IPv4 and IPv6', () => {
    expect(formatHostPort('example.com', 443)).toBe('example.com:443');
    expect(formatHostPort('::1', 443)).toBe('[::1]:443');
    expect(hostOfHostPort('example.com:443')).toBe('example.com');
    expect(hostOfHostPort('127.0.0.1:80')).toBe('127.0.0.1');
    expect(hostOfHostPort('[::1]:443')).toBe('::1');
    expect(hostOfHostPort('example.com')).toBe('example.com');
    expect(hostOfHostPort('::1')).toBe('::1');
  });
});

describe('violationToRecord', () => {
  test('network denials become net records with host:port + reason', () => {
    const record = violationToRecord(
      {
        line: 'deny network-outbound api.example.com:443 (host is on the deny list)',
        command: 'curl https://api.example.com',
        timestamp: new Date('2026-01-02T03:04:05Z'),
      },
      { cwd: '/repo' },
    );
    expect(record).toEqual({
      ts: '2026-01-02T03:04:05.000Z',
      kind: 'net',
      action: 'deny',
      command: 'curl https://api.example.com',
      cwd: '/repo',
      host: 'api.example.com:443',
      note: 'host is on the deny list',
    });
  });

  test('non-network violations are skipped', () => {
    expect(violationToRecord({ line: 'deny file-read-data /x' }, { cwd: '/' })).toBeUndefined();
  });
});

describe('createViolationFeed', () => {
  const ev = (line: string): AsrtViolationEvent => ({ line, timestamp: new Date() });

  test('forwards each event once even though the store re-sends the full list', () => {
    const onNew = vi.fn();
    const feed = createViolationFeed(onNew);
    const a = ev('a');
    const b = ev('b');
    feed([a]);
    feed([a, b]);
    feed([a, b]);
    expect(onNew.mock.calls.map((c) => (c[0] as AsrtViolationEvent).line)).toEqual(['a', 'b']);
  });

  test('skipBacklog ignores the events present at subscribe time', () => {
    const onNew = vi.fn();
    const feed = createViolationFeed(onNew, { skipBacklog: true });
    const old = ev('old');
    feed([old]);
    feed([old, ev('new')]);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect((onNew.mock.calls[0][0] as AsrtViolationEvent).line).toBe('new');
  });

  test('a throwing consumer does not break the feed', () => {
    const feed = createViolationFeed(() => {
      throw new Error('boom');
    });
    expect(() => feed([ev('x')])).not.toThrow();
  });
});
