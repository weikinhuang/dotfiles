/** Content-free diagnostics for any JSON provider payload. Raw bytes stay in memory only. */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { isRecord } from './shared/guards.ts';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
  kind: 'request';
  sequence: number;
  bytes: number;
  sha256: string;
  commonMessagePrefix: number;
  commonBytePrefix: number;
  firstDivergentMessage: number | null;
  messages: { index: number; role: string; bytes: number; sha256: string; reminderIds: string[] }[];
}

/** One tracer per session/model. JSON serialization is the hook payload, not an HTTP wire capture. */
export function createCacheTracer(): (payload: unknown, identity: CacheTraceIdentity) => CacheRequestTrace {
  let previous: string | undefined;
  let previousItems: string[] = [];
  let previousIdentity = '';
  let sequence = 0;
  return (payload, identity) => {
    const identityKey = JSON.stringify(identity);
    if (previousIdentity !== identityKey) {
      previous = undefined;
      previousItems = [];
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
    let prefix = 0;
    while (prefix < strings.length && prefix < previousItems.length && strings[prefix] === previousItems[prefix]) {
      prefix++;
    }
    const trace: CacheRequestTrace = {
      kind: 'request',
      ...identity,
      sequence: ++sequence,
      bytes: Buffer.byteLength(serialized),
      sha256: hash(serialized),
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
        sha256: hash(strings[index]),
        reminderIds: reminderIds(item),
      })),
    };
    previous = serialized;
    previousItems = strings;
    previousIdentity = identityKey;
    return trace;
  };
}

/** Allowlist numeric accounting fields. Never copy arbitrary response objects to a log. */
export function cacheResponseTrace(sequence: number, usage: unknown): Record<string, unknown> {
  const u = isRecord(usage) ? usage : {};
  const cost = isRecord(u.cost) ? u.cost : {};
  const numeric = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
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
export function appendCacheTrace(path: string | undefined, record: unknown): void {
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Diagnostics must not affect provider execution.
  }
}
