/**
 * Tests for lib/node/pi/sandbox/localhost-proxy.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  LOOPBACK_PROXY_ALLOW,
  NO_PROXY_WITHOUT_LOOPBACK,
  prependLocalhostProxyEnv,
} from '../../../../../lib/node/pi/sandbox/localhost-proxy.ts';

describe('LOOPBACK_PROXY_ALLOW', () => {
  test('is the three loopback hosts, no 0.0.0.0', () => {
    expect(LOOPBACK_PROXY_ALLOW).toEqual(['localhost', '127.0.0.1', '::1']);
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
