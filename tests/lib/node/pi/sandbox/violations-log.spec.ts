/**
 * Tests for lib/node/pi/sandbox/violations-log.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  appendViolation,
  DEFAULT_VIOLATIONS_LOG_MAX_BYTES,
  readViolations,
  type SandboxViolationRecord,
} from '../../../../../lib/node/pi/sandbox/violations-log.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-violog-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const sample = (over: Partial<SandboxViolationRecord> = {}): SandboxViolationRecord => ({
  ts: '2026-05-20T13:14:15.000Z',
  kind: 'fs',
  action: 'deny-read',
  command: 'cat ~/.ssh/id_rsa',
  cwd: '/repo',
  path: '/Users/x/.ssh/id_rsa',
  ...over,
});

describe('appendViolation', () => {
  test('writes a JSON line and creates parent directories', () => {
    const log = join(cwd, 'nested', 'sandbox-violations.log');
    const r = appendViolation(log, sample());
    expect(r.rotated).toBe(false);
    expect(r.wrote).toBeGreaterThan(0);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8').trimEnd()).toBe(JSON.stringify(sample()));
  });

  test('appends a newline-terminated record per call', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample());
    appendViolation(log, sample({ command: 'ls /etc' }));
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { command: string };
    const second = JSON.parse(lines[1]) as { command: string };
    expect(first.command).toBe('cat ~/.ssh/id_rsa');
    expect(second.command).toBe('ls /etc');
  });

  test('rotates when the file would exceed maxBytes', () => {
    const log = join(cwd, 'sandbox-violations.log');
    // Pre-fill with a chunk close to the rotation threshold.
    writeFileSync(log, 'x'.repeat(900));
    const r = appendViolation(log, sample(), { maxBytes: 1000 });
    expect(r.rotated).toBe(true);
    expect(r.rotatedTo).toBe(`${log}.1`);
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(statSync(`${log}.1`).size).toBe(900);
    // The new record went to the live file.
    expect(readFileSync(log, 'utf8').trim()).toBe(JSON.stringify(sample()));
  });

  test('does NOT rotate when the file is under threshold', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample());
    const r = appendViolation(log, sample());
    expect(r.rotated).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  test('default maxBytes is 5 MiB per spec', () => {
    expect(DEFAULT_VIOLATIONS_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('readViolations', () => {
  test('returns newest-first up to limit', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample({ command: 'first' }));
    appendViolation(log, sample({ command: 'second' }));
    appendViolation(log, sample({ command: 'third' }));
    const out = readViolations(log, { limit: 2 });
    expect(out.map((r) => r.command)).toEqual(['third', 'second']);
  });

  test('walks rotated backup when live file alone is short of limit', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample({ command: 'old1' }));
    appendViolation(log, sample({ command: 'old2' }));
    // Force a rotation.
    appendViolation(log, sample({ command: 'fresh' }), { maxBytes: 100 });
    appendViolation(log, sample({ command: 'newer' }));
    const out = readViolations(log, { limit: 4 });
    expect(out.map((r) => r.command)).toEqual(['newer', 'fresh', 'old2', 'old1']);
  });

  test('skips malformed lines silently', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample({ command: 'good' }));
    // Splice a malformed line.
    writeFileSync(log, `${readFileSync(log, 'utf8')}garbage{not-json\n`);
    appendViolation(log, sample({ command: 'good2' }));
    const out = readViolations(log);
    expect(out.map((r) => r.command)).toEqual(['good2', 'good']);
  });

  test('kind filter selects only the requested channel', () => {
    const log = join(cwd, 'sandbox-violations.log');
    appendViolation(log, sample({ kind: 'fs' }));
    appendViolation(log, sample({ kind: 'net', action: 'deny-connect', host: 'github.com' }));
    appendViolation(log, sample({ kind: 'fs' }));
    expect(readViolations(log, { kind: 'net' }).map((r) => r.kind)).toEqual(['net']);
    expect(readViolations(log, { kind: 'fs' }).map((r) => r.kind)).toEqual(['fs', 'fs']);
  });

  test('returns empty array when the log does not exist', () => {
    const log = join(cwd, 'nope.log');
    expect(readViolations(log)).toEqual([]);
  });
});
