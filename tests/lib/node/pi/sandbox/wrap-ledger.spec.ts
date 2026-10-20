/**
 * Tests for lib/node/pi/sandbox/wrap-ledger.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  createWrapLedger,
  drainWrapLedger,
  recordWrap,
  releaseWrap,
} from '../../../../../lib/node/pi/sandbox/wrap-ledger.ts';

describe('wrap-ledger', () => {
  test('release of a recorded wrap succeeds exactly once', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', ['/p/.bashrc']);
    expect(releaseWrap(ledger, 'a')).toEqual({ released: true, stubsToRemove: ['/p/.bashrc'] });
    expect(releaseWrap(ledger, 'a')).toEqual({ released: false, stubsToRemove: [] });
  });

  test('unknown or missing ids are never released (unwrapped commands)', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', []);
    expect(releaseWrap(ledger, 'b').released).toBe(false);
    expect(releaseWrap(ledger, undefined).released).toBe(false);
    expect(releaseWrap(ledger, '').released).toBe(false);
    expect(ledger.inflight.has('a')).toBe(true);
  });

  test('a stub shared by two in-flight wraps is removed only by the last release', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', ['/p/.bashrc', '/p/.zshrc']);
    recordWrap(ledger, 'b', ['/p/.bashrc']);
    expect(releaseWrap(ledger, 'a').stubsToRemove).toEqual(['/p/.zshrc']);
    expect(releaseWrap(ledger, 'b').stubsToRemove).toEqual(['/p/.bashrc']);
    expect(ledger.stubRefs.size).toBe(0);
  });

  test('re-recording an id does not double-count its stubs', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', ['/p/.bashrc']);
    recordWrap(ledger, 'a', ['/p/.bashrc']);
    expect(ledger.stubRefs.get('/p/.bashrc')).toBe(1);
  });

  test('a wrap with no stubs still releases (ASRT cleanup must run)', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', []);
    expect(releaseWrap(ledger, 'a')).toEqual({ released: true, stubsToRemove: [] });
  });

  test('drain returns every referenced stub and empties the ledger', () => {
    const ledger = createWrapLedger();
    recordWrap(ledger, 'a', ['/p/.bashrc']);
    recordWrap(ledger, 'b', ['/p/.bashrc', '/p/.idea']);
    expect(drainWrapLedger(ledger).sort()).toEqual(['/p/.bashrc', '/p/.idea']);
    expect(ledger.inflight.size).toBe(0);
    expect(ledger.stubRefs.size).toBe(0);
    expect(releaseWrap(ledger, 'a').released).toBe(false);
  });
});
