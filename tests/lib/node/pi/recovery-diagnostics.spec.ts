/**
 * Tests for lib/node/pi/recovery-diagnostics.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { makeDiagnostics, type NotifyContext, type NotifyLevel } from '../../../../lib/node/pi/recovery-diagnostics.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recovery-diag-spec-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const captureCtx = (hasUI: boolean): { ctx: NotifyContext; calls: [string, NotifyLevel][] } => {
  const calls: [string, NotifyLevel][] = [];
  const ctx: NotifyContext = {
    hasUI,
    ui: {
      notify(msg, level) {
        calls.push([msg, level]);
      },
    },
  };
  return { ctx, calls };
};

test('trace: appends `[label] msg\\n` to the configured path', () => {
  const p = join(tmp, 'trace.log');
  const d = makeDiagnostics({ label: 'edit-recovery', tracePath: p, debug: false });

  d.trace('one');
  d.trace('two');

  expect(readFileSync(p, 'utf8')).toBe('[edit-recovery] one\n[edit-recovery] two\n');
});

test('trace: no-op when tracePath is undefined', () => {
  const d = makeDiagnostics({ label: 'x', tracePath: undefined, debug: false });
  expect(() => d.trace('msg')).not.toThrow();
});

test('trace: swallows write errors (path points at a directory)', () => {
  const d = makeDiagnostics({ label: 'x', tracePath: tmp, debug: false });
  expect(() => d.trace('msg')).not.toThrow();
});

test('trace: appends to a pre-existing file', () => {
  const p = join(tmp, 'trace.log');
  writeFileSync(p, 'pre-existing\n');
  const d = makeDiagnostics({ label: 'l', tracePath: p, debug: false });

  d.trace('new');

  expect(readFileSync(p, 'utf8')).toBe('pre-existing\n[l] new\n');
});

test('notify: forwards to ctx.ui.notify when debug=true and hasUI=true', () => {
  const d = makeDiagnostics({ label: 'l', tracePath: undefined, debug: true });
  const { ctx, calls } = captureCtx(true);

  d.notify(ctx, 'hello');
  expect(calls).toEqual([['hello', 'info']]);
});

test('notify: respects an explicit level', () => {
  const d = makeDiagnostics({ label: 'l', tracePath: undefined, debug: true });
  const { ctx, calls } = captureCtx(true);

  d.notify(ctx, 'warn-msg', 'warning');
  d.notify(ctx, 'err-msg', 'error');
  expect(calls).toEqual([
    ['warn-msg', 'warning'],
    ['err-msg', 'error'],
  ]);
});

test('notify: silent when debug=false', () => {
  const d = makeDiagnostics({ label: 'l', tracePath: undefined, debug: false });
  const { ctx, calls } = captureCtx(true);

  d.notify(ctx, 'hello');
  expect(calls).toEqual([]);
});

test('notify: silent when hasUI=false (even with debug=true)', () => {
  const d = makeDiagnostics({ label: 'l', tracePath: undefined, debug: true });
  const { ctx, calls } = captureCtx(false);

  d.notify(ctx, 'hello');
  expect(calls).toEqual([]);
});
