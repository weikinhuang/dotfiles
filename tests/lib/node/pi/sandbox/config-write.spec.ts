/**
 * Tests for lib/node/pi/sandbox/config-write.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { JsoncReadError } from '../../../../../lib/node/pi/jsonc.ts';
import { addNetworkRule, addWriteAllowPath } from '../../../../../lib/node/pi/sandbox/config-write.ts';

interface SandboxJson {
  flags?: Record<string, unknown>;
  network?: { allow?: string[]; deny?: string[] };
}
interface FilesystemJson {
  read?: { deny?: { paths?: string[] } };
  write?: { allow?: { paths?: string[] } };
}
function parseSandbox(p: string): SandboxJson {
  return JSON.parse(readFileSync(p, 'utf8')) as SandboxJson;
}
function parseFs(p: string): FilesystemJson {
  return JSON.parse(readFileSync(p, 'utf8')) as FilesystemJson;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sandbox-config-write-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('addNetworkRule', () => {
  test('writes a fresh sandbox.json with allow + sorted entries', () => {
    const p = join(tmp, 'sandbox.json');
    addNetworkRule(p, 'allow', 'example.com');
    addNetworkRule(p, 'allow', 'a.example.com');

    expect(parseSandbox(p)).toEqual({
      network: { allow: ['a.example.com', 'example.com'] },
    });
  });

  test('idempotent on duplicate domains', () => {
    const p = join(tmp, 'sandbox.json');
    addNetworkRule(p, 'deny', 'evil.com');
    addNetworkRule(p, 'deny', 'evil.com');

    expect(parseSandbox(p).network?.deny).toEqual(['evil.com']);
  });

  test('preserves unrelated keys in the round-trip', () => {
    const p = join(tmp, 'sandbox.json');
    writeFileSync(p, JSON.stringify({ flags: { weakerNestedSandbox: true } }, null, 2));

    addNetworkRule(p, 'allow', 'example.com');

    const parsed = parseSandbox(p);
    expect(parsed.flags).toEqual({ weakerNestedSandbox: true });
    expect(parsed.network?.allow).toEqual(['example.com']);
  });

  test('aborts on malformed JSON via JsoncReadError', () => {
    const p = join(tmp, 'sandbox.json');
    writeFileSync(p, '{ not json');

    expect(() => addNetworkRule(p, 'allow', 'example.com')).toThrow(JsoncReadError);
    // File NOT clobbered.
    expect(readFileSync(p, 'utf8')).toBe('{ not json');
  });
});

describe('addWriteAllowPath', () => {
  test('writes a fresh filesystem.json with sorted paths', () => {
    const p = join(tmp, 'filesystem.json');
    addWriteAllowPath(p, '/var/log');
    addWriteAllowPath(p, '/tmp');

    expect(parseFs(p)).toEqual({
      write: { allow: { paths: ['/tmp', '/var/log'] } },
    });
  });

  test('idempotent on duplicate paths', () => {
    const p = join(tmp, 'filesystem.json');
    addWriteAllowPath(p, '/tmp');
    addWriteAllowPath(p, '/tmp');

    expect(parseFs(p).write?.allow?.paths).toEqual(['/tmp']);
  });

  test('preserves unrelated keys', () => {
    const p = join(tmp, 'filesystem.json');
    writeFileSync(p, JSON.stringify({ read: { deny: { paths: ['/etc/shadow'] } } }, null, 2));

    addWriteAllowPath(p, '/tmp');

    const parsed = parseFs(p);
    expect(parsed.read).toEqual({ deny: { paths: ['/etc/shadow'] } });
    expect(parsed.write?.allow?.paths).toEqual(['/tmp']);
  });

  test('aborts on malformed JSON via JsoncReadError', () => {
    const p = join(tmp, 'filesystem.json');
    writeFileSync(p, '{ malformed');

    expect(() => addWriteAllowPath(p, '/tmp')).toThrow(JsoncReadError);
    expect(readFileSync(p, 'utf8')).toBe('{ malformed');
  });
});
