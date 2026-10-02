import { resolve } from 'node:path';

export type CacheTraceLevel = 'hash' | 'system' | 'system-tools';

export function cacheTraceSidecarPath(sessionFile: string): string {
  return sessionFile.endsWith('.jsonl')
    ? `${sessionFile.slice(0, -6)}.cache-trace.jsonl`
    : `${sessionFile}.cache-trace.jsonl`;
}

export function isCacheTraceSidecar(path: string): boolean {
  return path.endsWith('.cache-trace.jsonl');
}

export function parseCacheTraceLevel(value: unknown): CacheTraceLevel {
  if (value === undefined) return 'hash';
  if (value === 'hash' || value === 'system' || value === 'system-tools') return value;
  throw new Error('cache trace level must be hash, system, or system-tools');
}

export function cacheTraceConfig(
  flags: { destination?: unknown; level?: unknown },
  env: Record<string, string | undefined>,
  sessionFile: string | undefined,
  cwd: string,
): { path?: string; level: CacheTraceLevel } {
  const destination =
    flags.destination ??
    env.PI_CACHE_TRACE ??
    (flags.level !== undefined || env.PI_CACHE_TRACE_LEVEL !== undefined ? 'auto' : undefined);
  const level = parseCacheTraceLevel(flags.level ?? env.PI_CACHE_TRACE_LEVEL);
  if (destination === undefined || destination === '' || destination === 'off') return { level };
  if (typeof destination !== 'string') throw new Error('cache trace destination must be auto, off, or a file path');
  if (destination === 'auto') {
    if (!sessionFile)
      throw new Error(
        'automatic cache tracing needs a persisted session; supply an explicit trace path for --no-session',
      );
    return { path: cacheTraceSidecarPath(sessionFile), level };
  }
  const path = resolve(cwd, destination);
  if (sessionFile && path === resolve(cwd, sessionFile))
    throw new Error('cache trace path must differ from the session transcript');
  return { path, level };
}
