/**
 * Baseline -> live settings merge behind `config/agents/sync.ts diff` /
 * `apply`. Format-agnostic: callers parse JSON, JSONC, or TOML into plain
 * objects first (TOML values may carry `bigint` integers and `Date`
 * subclasses, so nothing here assumes JSON-only values).
 *
 * Rule: keys present in the baseline are repo-owned and overwrite the
 * live value; objects deep-merge; arrays are replaced whole; every other
 * live key is kept untouched. Live key order is preserved and new keys
 * are appended in baseline order.
 */

import { parseJsonc } from '../pi/jsonc.ts';

export type SettingsObject = Record<string, unknown>;

/** Parses a settings file into an object and prints one back. */
export interface SettingsCodec {
  parse(text: string): SettingsObject;
  stringify(value: SettingsObject): string;
}

export type SettingsChange =
  | { kind: 'add'; path: string[]; after: unknown }
  | { kind: 'change'; path: string[]; before: unknown; after: unknown }
  | { kind: 'array'; path: string[]; before: unknown[] | undefined; removed: unknown[]; added: unknown[] };

export interface MergeResult {
  merged: SettingsObject;
  changes: SettingsChange[];
}

/**
 * Key names whose values never appear in diff output. `auth` and `key` only count at a word start or as a `_` / `-`
 * delimited part, so `authHeader`, `API_KEY`, and `apiKey` are hidden while `includeCoAuthoredBy` and `GIT_CONFIG_KEY_0`
 * are not.
 */
export const SECRET_KEY_RE =
  /token|secret|passw(?:or)?d|credential|bearer|cookie|api[-_]?key|(?:^|[-_])key$|(?:^|[-_])auth|authorization/i;

export const REDACTED = '<redacted>';

/** True for a non-array object (plain or null-prototype, as TOML parsers produce). */
export function isPlainObject(value: unknown): value is SettingsObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || proto === Object.prototype;
}

/** Order-insensitive (for object keys) canonical form used for equality. */
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${(value as unknown[]).map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function arrayChange(path: string[], before: unknown[] | undefined, after: unknown[]): SettingsChange {
  const beforeKeys = new Set((before ?? []).map(canonical));
  const afterKeys = new Set(after.map(canonical));
  return {
    kind: 'array',
    path,
    before,
    removed: (before ?? []).filter((v) => !afterKeys.has(canonical(v))),
    added: after.filter((v) => !beforeKeys.has(canonical(v))),
  };
}

/** Record the changes that adding the absent key `path` = `value` makes. */
function addChanges(path: string[], value: unknown, out: SettingsChange[]): void {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) addChanges([...path, key], child, out);
  } else if (Array.isArray(value)) {
    out.push(arrayChange(path, undefined, value as unknown[]));
  } else {
    out.push({ kind: 'add', path, after: value });
  }
}

function mergeInto(
  baseline: SettingsObject,
  live: SettingsObject,
  path: string[],
  out: SettingsChange[],
): SettingsObject {
  const merged: SettingsObject = {};
  for (const [key, liveValue] of Object.entries(live)) {
    if (!Object.hasOwn(baseline, key)) {
      merged[key] = liveValue;
      continue;
    }
    const baseValue = baseline[key];
    const childPath = [...path, key];
    if (isPlainObject(baseValue) && isPlainObject(liveValue)) {
      merged[key] = mergeInto(baseValue, liveValue, childPath, out);
    } else {
      merged[key] = baseValue;
      if (valuesEqual(baseValue, liveValue)) continue;
      if (Array.isArray(baseValue) && Array.isArray(liveValue)) {
        out.push(arrayChange(childPath, liveValue as unknown[], baseValue as unknown[]));
      } else {
        out.push({ kind: 'change', path: childPath, before: liveValue, after: baseValue });
      }
    }
  }
  for (const [key, baseValue] of Object.entries(baseline)) {
    if (Object.hasOwn(live, key)) continue;
    merged[key] = baseValue;
    addChanges([...path, key], baseValue, out);
  }
  return merged;
}

/**
 * JSON / JSONC codec. Parsing accepts comments and trailing commas;
 * printing is 2-space JSON with a trailing newline, so comments in a
 * merged JSONC file do not survive.
 */
export const JSON_CODEC: SettingsCodec = {
  parse(text: string): SettingsObject {
    const value = parseJsonc(text);
    if (!isPlainObject(value)) throw new Error('expected a top-level object');
    return value;
  },
  stringify(value: SettingsObject): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  },
};

/** Merge `baseline` over `live`; `changes` is empty when the live file already matches. */
export function mergeSettings(baseline: SettingsObject, live: SettingsObject): MergeResult {
  const changes: SettingsChange[] = [];
  const merged = mergeInto(baseline, live, [], changes);
  return { merged, changes };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Replace the value of every secret-looking key, at any depth, with {@link REDACTED}. */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(redactValue);
  if (!isPlainObject(value)) return value;
  const out: SettingsObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(child);
  return out;
}

/** Compact one-line rendering; handles TOML `bigint` and dates. */
export function formatValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${(value as unknown[]).map(formatValue).join(', ')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v)}`);
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

function formatPath(path: string[]): string {
  return path.map((key) => (/^[A-Za-z0-9_$-]+$/.test(key) ? key : JSON.stringify(key))).join('.');
}

function isSecretPath(path: string[]): boolean {
  return path.some((key) => SECRET_KEY_RE.test(key));
}

function show(path: string[], value: unknown): string {
  return isSecretPath(path) ? REDACTED : formatValue(redactValue(value));
}

/** Diff lines for one change (no indentation); secrets are redacted. */
export function renderSettingsChange(change: SettingsChange): string[] {
  const path = formatPath(change.path);
  switch (change.kind) {
    case 'add':
      return [`+ ${path}: ${show(change.path, change.after)}`];
    case 'change':
      return [`~ ${path}: ${show(change.path, change.before)} -> ${show(change.path, change.after)}`];
    case 'array': {
      const head =
        change.before === undefined
          ? `+ ${path}: array of ${change.added.length}`
          : `~ ${path}: array, ${change.removed.length} removed, ${change.added.length} added`;
      const reordered = change.before !== undefined && change.removed.length === 0 && change.added.length === 0;
      return [
        reordered ? `~ ${path}: array reordered` : head,
        ...change.removed.map((v) => `    - ${show(change.path, v)}`),
        ...change.added.map((v) => `    + ${show(change.path, v)}`),
      ];
    }
  }
}
