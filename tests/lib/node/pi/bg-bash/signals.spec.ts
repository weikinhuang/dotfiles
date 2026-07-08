/**
 * Guards the bg-bash signal name list (lib/node/pi/bg-bash/signals.ts).
 * The extension's `signal` action schema and the `/bg-bash` overlay both
 * key off this list, so the exact set is behaviour and worth pinning.
 */

import { expect, test } from 'vitest';

import { SIGNALS } from '../../../../../lib/node/pi/bg-bash/signals.ts';

test('SIGNALS: is the expected POSIX set in order', () => {
  expect([...SIGNALS]).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']);
});

test('SIGNALS: SIGTERM (default) and SIGKILL are present', () => {
  expect(SIGNALS).toContain('SIGTERM');
  expect(SIGNALS).toContain('SIGKILL');
});
