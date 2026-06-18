/**
 * Tests for lib/node/pi/sandbox/loopback-hint.ts.
 */

import { describe, expect, test } from 'vitest';

import { LOOPBACK_FAILURE_HINT, detectLoopbackFailure } from '../../../../../lib/node/pi/sandbox/loopback-hint.ts';

describe('detectLoopbackFailure', () => {
  test('fires on a curl localhost connection-refused failure', () => {
    const out = 'curl: (7) Failed to connect to localhost port 18080 after 0 ms: Connection refused';
    expect(detectLoopbackFailure(out)).toBe(LOOPBACK_FAILURE_HINT);
  });

  test('fires on a 127.0.0.1 connection-refused failure', () => {
    const out = 'curl: (7) Failed to connect to 127.0.0.1 port 8080: Connection refused';
    expect(detectLoopbackFailure(out)).toBe(LOOPBACK_FAILURE_HINT);
  });

  test('fires on a wget localhost failure', () => {
    const out = 'wget: unable to connect to localhost:3000: Connection refused';
    // "unable to connect" is not in the pattern set, but "Connection refused" is.
    expect(detectLoopbackFailure(out)).toBe(LOOPBACK_FAILURE_HINT);
  });

  test('fires on ::1 with "Couldn\'t connect"', () => {
    const out = "curl: (7) Couldn't connect to server at ::1";
    expect(detectLoopbackFailure(out)).toBe(LOOPBACK_FAILURE_HINT);
  });

  test('fires on empty reply from a localhost server', () => {
    const out = 'curl: (52) Empty reply from server\nconnecting to localhost:5000';
    expect(detectLoopbackFailure(out)).toBe(LOOPBACK_FAILURE_HINT);
  });

  test('does NOT fire for a remote-host connection failure (allow-list block)', () => {
    const out = 'curl: (7) Failed to connect to api.example.com port 443: Connection refused';
    expect(detectLoopbackFailure(out)).toBeUndefined();
  });

  test('does NOT fire when localhost is mentioned without a connection failure', () => {
    const out = 'Server listening on localhost:8080\nGET / 200 OK';
    expect(detectLoopbackFailure(out)).toBeUndefined();
  });

  test('does NOT fire when there is a connection failure but no loopback host', () => {
    const out = 'curl: (28) Connection timed out after 5000 ms to example.org';
    expect(detectLoopbackFailure(out)).toBeUndefined();
  });

  test('does NOT trip the bare "localhost" token inside a longer word', () => {
    const out = 'error in localhostingservice: Connection refused';
    expect(detectLoopbackFailure(out)).toBeUndefined();
  });

  test('empty / undefined input returns undefined', () => {
    expect(detectLoopbackFailure(undefined)).toBeUndefined();
    expect(detectLoopbackFailure('')).toBeUndefined();
  });

  test('hint text names the escape routes', () => {
    expect(LOOPBACK_FAILURE_HINT).toContain('network.allowLocalhost');
    expect(LOOPBACK_FAILURE_HINT).toContain('docker exec');
    expect(LOOPBACK_FAILURE_HINT).toContain('SAME bash command');
    expect(LOOPBACK_FAILURE_HINT).toContain('/sandbox-disable');
    expect(LOOPBACK_FAILURE_HINT).toContain('network.unrestricted');
  });
});
