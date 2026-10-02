/** Provider-neutral metadata; raw system/schema snapshots require an explicit logging level. */
import { closeSync, constants, fchmodSync, fstatSync, openSync, statSync, writeFileSync } from 'node:fs';

import type { CacheTraceLevel } from './cache-trace-config.ts';
import { extractTraceScopes, traceHash, type CacheTraceScope } from './cache-trace-scopes.ts';
import { isRecord } from './shared/guards.ts';

function commonBytes(a: string, b: string): number {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  let i = 0;
  while (i < left.length && i < right.length && left[i] === right[i]) i++;
  return i;
}

function reminderIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/<system-reminder id="([a-z0-9-]{1,64})">/g)) ids.add(match[1]);
    } else if (Array.isArray(node)) {
      for (const child of node as unknown[]) visit(child);
    } else if (isRecord(node)) {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(value);
  return [...ids].sort();
}

export interface CacheTraceIdentity {
  provider: string;
  model: string;
}

export interface CacheRequestTrace extends CacheTraceIdentity {
  version: 2;
  runId?: string;
  system: CacheTraceScope;
  tools: CacheTraceScope;
  /** Runtime writes these separately, before the request record; absent at hash level. */
  snapshots?: CacheTraceSnapshot[];
  kind: 'request';
  sequence: number;
  bytes: number;
  sha256: string;
  commonMessagePrefix: number;
  commonBytePrefix: number;
  firstDivergentMessage: number | null;
  messages: { index: number; role: string; bytes: number; sha256: string; reminderIds: string[] }[];
}

export interface CacheTraceSnapshot {
  kind: 'snapshot';
  version: 2;
  runId?: string;
  scope: 'system' | 'tools';
  sha256: string;
  textSha256: string;
  text: string;
}

/** One tracer per session/model. JSON serialization is the hook payload, not an HTTP wire capture. */
export function createCacheTracer(
  options: { runId?: string; level?: CacheTraceLevel } = {},
): (payload: unknown, identity: CacheTraceIdentity) => CacheRequestTrace {
  let previous: string | undefined;
  let previousItems: string[] = [];
  let previousIdentity = '';
  let sequence = 0;
  let previousScopes: { system: string; tools: string } | undefined;
  const stored = new Set<string>();
  return (payload, identity) => {
    const identityKey = JSON.stringify(identity);
    if (previousIdentity !== identityKey) {
      previous = undefined;
      previousItems = [];
      previousScopes = undefined;
    }
    const serialized = JSON.stringify(payload) ?? 'null';
    const items: unknown[] = isRecord(payload)
      ? Array.isArray(payload.messages)
        ? (payload.messages as unknown[])
        : Array.isArray(payload.input)
          ? (payload.input as unknown[])
          : []
      : [];
    const strings = items.map((item) => JSON.stringify(item) ?? 'null');
    const scopes = extractTraceScopes(payload);
    const snapshots: CacheTraceSnapshot[] = [];
    for (const scope of ['system', 'tools'] as const) {
      const part = scopes[scope];
      part.metadata.changed = previousScopes === undefined ? null : previousScopes[scope] !== part.metadata.sha256;
      const capture =
        scope === 'system'
          ? options.level === 'system' || options.level === 'system-tools'
          : options.level === 'system-tools';
      const key = `${scope}:${part.metadata.sha256}`;
      if (capture && !stored.has(key)) {
        snapshots.push({
          kind: 'snapshot',
          version: 2,
          ...(options.runId ? { runId: options.runId } : {}),
          scope,
          sha256: part.metadata.sha256,
          textSha256: traceHash(part.text),
          text: part.text,
        });
        if (stored.size >= 1000) stored.clear();
        stored.add(key);
      }
    }
    let prefix = 0;
    while (prefix < strings.length && prefix < previousItems.length && strings[prefix] === previousItems[prefix]) {
      prefix++;
    }
    const trace: CacheRequestTrace = {
      version: 2,
      ...(options.runId ? { runId: options.runId } : {}),
      system: scopes.system.metadata,
      tools: scopes.tools.metadata,
      ...(snapshots.length ? { snapshots } : {}),
      kind: 'request',
      ...identity,
      sequence: ++sequence,
      bytes: Buffer.byteLength(serialized),
      sha256: traceHash(serialized),
      commonMessagePrefix: prefix,
      commonBytePrefix: previous === undefined ? 0 : commonBytes(previous, serialized),
      firstDivergentMessage: previous === undefined || prefix === previousItems.length ? null : prefix,
      messages: items.map((item, index) => ({
        index,
        role:
          isRecord(item) &&
          ['system', 'developer', 'user', 'assistant', 'tool', 'toolResult'].includes(String(item.role))
            ? String(item.role)
            : isRecord(item) &&
                [
                  'function_call',
                  'function_call_output',
                  'custom_tool_call',
                  'custom_tool_call_output',
                  'reasoning',
                ].includes(String(item.type))
              ? String(item.type)
              : 'unknown',
        bytes: Buffer.byteLength(strings[index]),
        sha256: traceHash(strings[index]),
        reminderIds: reminderIds(item),
      })),
    };
    previous = serialized;
    previousItems = strings;
    previousIdentity = identityKey;
    previousScopes = { system: scopes.system.metadata.sha256, tools: scopes.tools.metadata.sha256 };
    return trace;
  };
}

/** Allowlist numeric accounting fields. Never copy arbitrary response objects to a log. */
export function cacheResponseTrace(sequence: number, usage: unknown, runId?: string): Record<string, unknown> {
  const u = isRecord(usage) ? usage : {};
  const cost = isRecord(u.cost) ? u.cost : {};
  const numeric = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    version: 2,
    ...(runId ? { runId } : {}),
    kind: 'response',
    sequence,
    input: numeric(u.input),
    output: numeric(u.output),
    cacheRead: numeric(u.cacheRead),
    cacheWrite: numeric(u.cacheWrite),
    cost: Object.fromEntries(
      ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map((key) => [key, numeric(cost[key])]),
    ),
  };
}

/** Logs are append-only, opt-in, and best-effort. Missing/unwritable paths never break a request. */
export function appendCacheTraceRecords(
  path: string | undefined,
  records: readonly unknown[],
  sessionFile?: string,
): boolean {
  if (!path) return false;
  let fd: number | undefined;
  try {
    // Refuse symlinks, and tighten an existing trace too, especially when raw capture is enabled.
    fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    if (sessionFile) {
      try {
        const original = statSync(sessionFile, { bigint: true });
        const target = fstatSync(fd, { bigint: true });
        // Catch hardlinks and case-insensitive aliases before changing permissions or appending bytes.
        if (original.dev === target.dev && original.ino === target.ino) return false;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
      }
    }
    fchmodSync(fd, 0o600);
    writeFileSync(fd, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
    return true;
  } catch {
    // Diagnostics must not affect provider execution.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Best-effort teardown. */
      }
    }
  }
}

export function appendCacheTrace(path: string | undefined, record: unknown, sessionFile?: string): boolean {
  return appendCacheTraceRecords(path, [record], sessionFile);
}
