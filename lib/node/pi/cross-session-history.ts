/**
 * Pure helpers for the `cross-session-history` extension.
 *
 * Walks the session bucket on disk (`~/.pi/agent/sessions/<slug>/`)
 * and pulls out the user-typed prompts from prior sessions in
 * chronological order so the editor's arrow-up history can be
 * pre-populated with them.
 *
 * "Cross session, not cross project" falls out for free: pi already
 * buckets session jsonls per project under a slugified-cwd directory,
 * so we just read every `*.jsonl` in that one directory. The current
 * session's file is filtered out via `excludeFile`; its in-memory
 * entries are supplied separately so replacing the editor doesn't
 * discard recall history on resume or reload.
 *
 * Pure module - imports only `node:*` - so it's directly testable
 * with vitest under `tests/lib/node/pi/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCacheTraceSidecar } from './cache-trace-config.ts';

/** Default max number of prompts to load. Editor caps internal history at 100. */
export const DEFAULT_MAX_PROMPTS = 100;
/** Default max number of session files to scan (newest-first). */
export const DEFAULT_MAX_FILES = 100;
/** Cap memory for a single JSONL line; oversized tool/image lines are skipped,
 * not the entire session containing them. */
export const DEFAULT_MAX_LINE_BYTES = 5 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/** Default per-prompt length cap. Drop pasted blocks far larger than a line of
 * normal user input - they bloat the editor's history ring without being
 * useful to scroll back to. */
export const DEFAULT_MAX_PROMPT_LENGTH = 4000;

/**
 * Inputs for {@link loadCrossSessionHistory}. All paths are absolute.
 */
export interface LoadHistoryOptions {
  /** Project-scoped session bucket, i.e. `ctx.sessionManager.getSessionDir()`. */
  sessionDir: string;
  /** Active session file (`ctx.sessionManager.getSessionFile()`). Skipped when
   * its prompts are restored separately through `currentEntries`. */
  excludeFile?: string;
  /** Active session's entries, appended after prior-session prompts. These
   * restore history lost when installing a replacement editor. */
  currentEntries?: readonly unknown[];
  /** Max number of prompts to return. Defaults to {@link DEFAULT_MAX_PROMPTS}. */
  maxPrompts?: number;
  /** Max number of session files to read. Defaults to {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number;
  /** Optional whole-file byte cap. No whole-file cap by default. */
  maxFileBytes?: number;
  /** Skip individual prompts longer than this. Defaults to {@link DEFAULT_MAX_PROMPT_LENGTH}. */
  maxPromptLength?: number;
}

interface ExtractOptions {
  maxFileBytes?: number;
  maxPromptLength: number;
  maxPrompts?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizePrompt(text: string): string {
  // Trim trailing whitespace; the editor's `addToHistory` already trims for
  // the duplicate-of-most-recent check, but normalizing here gives the cap
  // and dedup logic a stable shape to compare against.
  return text.replace(/\s+$/u, '');
}

/**
 * Pull a user-typed prompt string out of one parsed jsonl entry, or
 * `undefined` if the entry isn't a user message we want to surface.
 *
 * Surfaced:
 *  - `{type:"message", message:{role:"user", content:"..."}}`
 *  - `{type:"message", message:{role:"user", content:[{type:"text", text:"..."}, ...]}}`
 *
 * NOT surfaced (intentional - they're not user-typed):
 *  - assistant / toolResult / bashExecution messages
 *  - `custom` / `custom_message` extension entries
 *  - session header, model_change, thinking_level_change, compaction, etc.
 */
export function userPromptFromEntry(entry: unknown): string | undefined {
  if (!isObject(entry)) return undefined;
  if (entry.type !== 'message') return undefined;
  const message = entry.message;
  if (!isObject(message)) return undefined;
  if (message.role !== 'user') return undefined;
  const content = message.content;
  if (typeof content === 'string') return normalizePrompt(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  if (parts.length === 0) return undefined;
  return normalizePrompt(parts.join('\n'));
}

/**
 * Pure-string variant of {@link extractUserPromptsFromFile} - used by the
 * vitest suite to avoid round-tripping through the filesystem. Splits on
 * newlines, parses each line as JSON, and pulls user-message text content.
 */
export function extractUserPromptsFromText(jsonl: string, maxPromptLength: number): string[] {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const prompt = userPromptFromEntry(entry);
    if (prompt === undefined) continue;
    if (prompt.length === 0 || prompt.length > maxPromptLength) continue;
    out.push(prompt);
  }
  return out;
}

/**
 * Parse a session jsonl and return user-typed prompts in document order
 * (which is chronological per pi's session-format). Scans backwards in bounded
 * chunks, stopping once enough recent prompts have been found. Oversized lines
 * are discarded without allocating their full contents. Throws on filesystem
 * errors; safe-ignores per-line JSON parse errors.
 */
export function extractUserPromptsFromFile(file: string, opts: ExtractOptions): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (opts.maxFileBytes !== undefined && stat.size > opts.maxFileBytes)) return [];
    const limit = opts.maxPrompts ?? Infinity;
    const newest: string[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = stat.size;
    let fragments: Buffer[] = [];
    let lineBytes = 0;

    const addFragment = (fragment: Buffer): void => {
      lineBytes += fragment.length;
      if (lineBytes > DEFAULT_MAX_LINE_BYTES) fragments = [];
      else if (fragment.length > 0) fragments.push(Buffer.from(fragment));
    };
    const finishLine = (): void => {
      if (lineBytes > 0 && lineBytes <= DEFAULT_MAX_LINE_BYTES) {
        const line = Buffer.concat(fragments.reverse()).toString('utf8');
        const prompt = extractUserPromptsFromText(line, opts.maxPromptLength)[0];
        if (prompt !== undefined) newest.push(prompt);
      }
      fragments = [];
      lineBytes = 0;
    };

    while (position > 0 && newest.length < limit) {
      const length = Math.min(chunk.length, position);
      position -= length;
      // A file may be truncated concurrently. Never parse unfilled buffer bytes.
      let bytesRead = 0;
      while (bytesRead < length) {
        const count = fs.readSync(fd, chunk, bytesRead, length - bytesRead, position + bytesRead);
        if (count === 0) return newest.reverse();
        bytesRead += count;
      }
      let end = length;
      for (let i = length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        addFragment(chunk.subarray(i + 1, end));
        finishLine();
        if (newest.length >= limit) return newest.reverse();
        end = i;
      }
      addFragment(chunk.subarray(0, end));
    }
    if (newest.length < limit) finishLine();
    return newest.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * List `.jsonl` files in `sessionDir`, newest-first by mtime with filename
 * fallback. Returns absolute paths. Excludes `excludeFile` (typically the
 * active session) and is robust to a missing directory.
 */
export function listSessionFilesNewestFirst(sessionDir: string, excludeFile?: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }

  const candidates: { file: string; mtimeMs: number; name: string }[] = [];
  const excludeAbs = excludeFile ? path.resolve(excludeFile) : undefined;

  for (const name of entries) {
    if (!name.endsWith('.jsonl') || isCacheTraceSidecar(name)) continue;
    const file = path.join(sessionDir, name);
    if (excludeAbs && path.resolve(file) === excludeAbs) continue;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ file, mtimeMs, name });
  }

  // Newest first by mtime; stable tie-break on filename descending so the
  // ISO-timestamp prefix gives a deterministic order when mtimes match.
  candidates.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
  return candidates.map((c) => c.file);
}

/**
 * Read the session bucket and return user prompts in chronological order
 * (oldest first), followed by active-session prompts, capped at `maxPrompts`.
 * Missing/unreadable files are skipped without losing active-session history.
 */
export function loadCrossSessionHistory(opts: LoadHistoryOptions): string[] {
  const maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxPromptLength = opts.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;

  if (maxPrompts <= 0) return [];

  const collected: string[] = [];
  for (const entry of opts.currentEntries ?? []) {
    const prompt = userPromptFromEntry(entry);
    if (prompt !== undefined && prompt.length > 0 && prompt.length <= maxPromptLength) collected.push(prompt);
  }
  if (collected.length >= maxPrompts) return collected.slice(-maxPrompts);
  if (maxFiles <= 0) return collected;

  const files = listSessionFilesNewestFirst(opts.sessionDir, opts.excludeFile);
  // Walk newest-first and prepend each file's chronological prompts, keeping
  // active-session prompts at the top of recall regardless of the file's mtime.
  for (const file of files.slice(0, maxFiles)) {
    let prompts: string[];
    try {
      prompts = extractUserPromptsFromFile(file, {
        maxFileBytes: opts.maxFileBytes,
        maxPromptLength,
        maxPrompts: maxPrompts - collected.length,
      });
    } catch {
      // Corrupt / unreadable file: skip it.
      continue;
    }
    if (prompts.length === 0) continue;
    collected.unshift(...prompts);
    if (collected.length >= maxPrompts) break;
  }

  if (collected.length <= maxPrompts) return collected;
  return collected.slice(collected.length - maxPrompts);
}

/**
 * Dedup a chronological prompt list (oldest first) and return the unique
 * prompts in **most-recent-first** order. The most recent occurrence of a
 * prompt is the one kept, so a prompt that recurs over the months bubbles
 * to the top of the reverse-search list rather than getting buried by its
 * old self.
 *
 * Used by the reverse-search overlay - the editor's own arrow-up history
 * already deduplicates consecutive duplicates and doesn't need this.
 */
export function dedupKeepMostRecent(prompts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = prompts.length - 1; i >= 0; i--) {
    const prompt = prompts[i];
    if (prompt === undefined) continue;
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    out.push(prompt);
  }
  return out;
}
