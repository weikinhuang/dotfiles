import { expect, test } from 'vitest';

import {
  cacheTraceConfig,
  cacheTraceSidecarPath,
  isCacheTraceSidecar,
  parseCacheTraceLevel,
} from '../../../../lib/node/pi/cache-trace-config.ts';

test('logging is off by default, hashes by default when enabled, and flags override env', () => {
  expect(cacheTraceConfig({}, {}, '/sessions/a.jsonl', '/cwd')).toEqual({ level: 'hash' });
  expect(cacheTraceConfig({}, { PI_CACHE_TRACE: 'auto' }, '/sessions/a.jsonl', '/cwd')).toEqual({
    path: '/sessions/a.cache-trace.jsonl',
    level: 'hash',
  });
  expect(
    cacheTraceConfig(
      { destination: 'off' },
      { PI_CACHE_TRACE: 'auto', PI_CACHE_TRACE_LEVEL: 'system' },
      '/sessions/a.jsonl',
      '/cwd',
    ).path,
  ).toBeUndefined();
  expect(cacheTraceConfig({ level: 'system' }, {}, '/sessions/a.jsonl', '/cwd').path).toBe(
    '/sessions/a.cache-trace.jsonl',
  );
  expect(
    cacheTraceConfig(
      { destination: 'trace.jsonl', level: 'hash' },
      { PI_CACHE_TRACE_LEVEL: 'system-tools' },
      undefined,
      '/cwd',
    ),
  ).toEqual({ path: '/cwd/trace.jsonl', level: 'hash' });
});

test('invalid modes, no-session auto paths, and transcript overwrites fail safely', () => {
  expect(() => parseCacheTraceLevel('full')).toThrow('hash, system, or system-tools');
  expect(() => cacheTraceConfig({ destination: 'auto' }, {}, undefined, '/cwd')).toThrow('persisted session');
  expect(() => cacheTraceConfig({ destination: 'a.jsonl' }, {}, '/cwd/a.jsonl', '/cwd')).toThrow('differ from');
  expect(cacheTraceSidecarPath('/sessions/a')).toBe('/sessions/a.cache-trace.jsonl');
  expect(isCacheTraceSidecar('a.cache-trace.jsonl')).toBe(true);
  expect(isCacheTraceSidecar('a.jsonl')).toBe(false);
});
