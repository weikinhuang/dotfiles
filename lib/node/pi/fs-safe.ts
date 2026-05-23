/**
 * Pi-free filesystem wrappers that swallow errors and return a typed
 * `undefined` (or `{ reason }`) instead of throwing. Extensions that
 * need "best effort" reads - status injection, diagnostic logging,
 * cache lookups - share these wrappers so the call sites stay focused
 * on the policy decision instead of repeating the same try/catch each
 * time.
 *
 * Throwing variants (`readFileSync`, `statSync`, …) remain the right
 * choice when a missing file should propagate as a fatal config error.
 * These helpers exist for the opposite case: missing/unreadable is a
 * normal control-flow signal.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { parseJsonc } from './jsonc.ts';

/**
 * `readFileSync(path, 'utf8')` that returns `null` on any error (missing,
 * unreadable, EISDIR, …). The raw-text sibling of {@link readJsonOrUndefined}
 * for callers that want "best-effort string read or null" without owning the
 * try/catch themselves. Returns `null` (not `undefined`) so callers can
 * distinguish "explicit miss" from "field not set" with `??`.
 */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `readFileSync(path, 'utf8')` that returns `''` on any error. The empty-string
 * sibling of {@link readTextOrNull} for callers whose downstream parser treats
 * `''` as "layer absent" (multi-layer config loaders that concatenate or merge
 * rule files - filesystem-policy, sandbox, …). Returning `''` instead of
 * `null` saves the caller a `?? ''` at every site.
 */
export function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * `statSync(path)` that returns `undefined` when the path is missing or
 * unreadable. Only the two fields callers actually need (`mtimeMs`,
 * `size`) are surfaced - keeps the return type narrow and avoids leaking
 * the rest of the `Stats` object as an implicit contract.
 */
export function safeStatSync(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

/**
 * Read + `JSON.parse` a file. Returns `undefined` for missing /
 * unreadable / malformed inputs. Use when an optional settings file
 * may legitimately be absent and bad JSON should silently fall back to
 * defaults rather than crash the extension.
 */
export function readJsonOrUndefined<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read + `parseJsonc` a file. Returns `undefined` for missing /
 * unreadable / malformed inputs. JSONC-aware variant of
 * {@link readJsonOrUndefined} for settings files where `//` comments
 * are permitted (the convention across most `~/.pi/*.json` configs in
 * this repo).
 */
export function readJsoncOrUndefined<T = unknown>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseJsonc<T>(raw);
  } catch {
    return undefined;
  }
}

export interface BoundedReadResult {
  /** Successfully-read content, or `undefined` if the read was skipped. */
  content: string | undefined;
  /** When `content` is undefined, a short human-readable reason. */
  reason?: string;
}

/**
 * Read `inputPath` (resolved against `cwd` if relative), gated on a
 * maximum byte size. The intent is "read this file, but don't blow the
 * caller's memory budget if it's unexpectedly huge" - the byte gate is
 * deliberately a hard limit, not a truncation, so callers see a clear
 * reason string when the file is too big to ship through.
 *
 *   - `content` set, no `reason`        - file read OK.
 *   - `content` undefined + `reason`    - skipped; reason explains why.
 *
 * Used by edit-recovery (and any future caller that wants the same
 * shape) so the policy decision lives at the call site while the I/O
 * boilerplate is shared.
 */
export function boundedReadFile(cwd: string, inputPath: string, maxBytes: number): BoundedReadResult {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return { content: undefined, reason: 'stat failed (missing or unreadable)' };
  }
  if (size > maxBytes) {
    return { content: undefined, reason: `file too large (${size} > ${maxBytes})` };
  }
  try {
    return { content: readFileSync(absolute, 'utf8') };
  } catch {
    return { content: undefined, reason: 'read failed' };
  }
}
