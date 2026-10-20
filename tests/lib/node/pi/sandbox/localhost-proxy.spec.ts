/**
 * Tests for lib/node/pi/sandbox/localhost-proxy.ts.
 */

import { describe, expect, test } from 'vitest';

// Deep import (tests may import anything): ASRT's own env builder, used
// to pin NO_PROXY_WITHOUT_LOOPBACK to the installed runtime's list.
import { generateProxyEnvVars } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';

import {
  LOOPBACK_PROXY_ALLOW,
  loopbackAllowEntries,
  NO_PROXY_WITHOUT_LOOPBACK,
  prependLocalhostProxyEnv,
} from '../../../../../lib/node/pi/sandbox/localhost-proxy.ts';

describe('LOOPBACK_PROXY_ALLOW', () => {
  test('is the three loopback hosts (IPv6 bracketed), no 0.0.0.0', () => {
    expect(LOOPBACK_PROXY_ALLOW).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });
});

describe('loopbackAllowEntries', () => {
  test('no ports = the bare loopback hosts', () => {
    expect(loopbackAllowEntries()).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(loopbackAllowEntries([])).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  test('ports scope every loopback host with host:port entries', () => {
    expect(loopbackAllowEntries([8188, 3000])).toEqual([
      'localhost:8188',
      'localhost:3000',
      '127.0.0.1:8188',
      '127.0.0.1:3000',
      '[::1]:8188',
      '[::1]:3000',
    ]);
  });
});

describe('NO_PROXY_WITHOUT_LOOPBACK', () => {
  test('drops loopback hosts but keeps private / link-local ranges', () => {
    const entries = NO_PROXY_WITHOUT_LOOPBACK.split(',');
    expect(entries).not.toContain('localhost');
    expect(entries).not.toContain('127.0.0.1');
    expect(entries).not.toContain('::1');
    expect(entries).toContain('10.0.0.0/8');
    expect(entries).toContain('169.254.0.0/16');
    expect(entries).toContain('192.168.0.0/16');
  });

  test('does not re-add *.local / .local (ASRT >= 0.0.62 routes them via the proxy)', () => {
    const entries = NO_PROXY_WITHOUT_LOOPBACK.split(',');
    expect(entries).not.toContain('*.local');
    expect(entries).not.toContain('.local');
  });

  test('equals the installed ASRT NO_PROXY minus the loopback hosts', () => {
    const vars = generateProxyEnvVars(3128, 1080);
    const asrt = vars.find((v: string) => v.startsWith('NO_PROXY='))?.slice('NO_PROXY='.length) ?? '';
    const expected = asrt
      .split(',')
      .filter((e: string) => !['localhost', '127.0.0.1', '::1'].includes(e))
      .join(',');
    expect(NO_PROXY_WITHOUT_LOOPBACK).toBe(expected);
  });
});

describe('prependLocalhostProxyEnv', () => {
  test('prepends a NO_PROXY export before the command', () => {
    const out = prependLocalhostProxyEnv('curl http://localhost:8080/');
    expect(out).toBe(
      `export NO_PROXY='${NO_PROXY_WITHOUT_LOOPBACK}' no_proxy='${NO_PROXY_WITHOUT_LOOPBACK}'; curl http://localhost:8080/`,
    );
  });

  test('the prefix sets both upper- and lower-case NO_PROXY', () => {
    const out = prependLocalhostProxyEnv('true');
    expect(out.startsWith('export NO_PROXY=')).toBe(true);
    expect(out).toContain('no_proxy=');
  });

  test('does not mention any loopback host in the NO_PROXY it sets', () => {
    const out = prependLocalhostProxyEnv('cmd');
    const exportClause = out.slice(0, out.indexOf('; cmd'));
    expect(exportClause).not.toContain('127.0.0.1');
    expect(exportClause).not.toContain('localhost');
    expect(exportClause).not.toContain('::1');
  });

  test('preserves the original command verbatim after the separator', () => {
    const cmd = 'cd /repo && FOO=bar ./run.sh --flag';
    const out = prependLocalhostProxyEnv(cmd);
    expect(out.endsWith(`; ${cmd}`)).toBe(true);
  });
});
