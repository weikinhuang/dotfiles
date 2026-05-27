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
 * session's file is filtered out via `excludeFile` so the
 * pi-runtime's own in-session `addToHistory` calls aren't doubled.
 *
 * Pure module - imports only `node:*` - so it's directly testable
 * with vitest under `tests/lib/node/pi/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default max number of prompts to load. Editor caps internal history at 100. */
export const DEFAULT_MAX_PROMPTS = 100;
/** Default max number of session files to scan (newest-first). */
export const DEFAULT_MAX_FILES = 100;
/** Default per-file size cap. Skip session files larger than this to avoid
 * pathological cases where a single session contains 100MB of pasted output. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
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
  /** Active session file (`ctx.sessionManager.getSessionFile()`). Skipped so
   * pi's per-session `addToHistory` isn't double-counted. */
  excludeFile?: string;
  /** Max number of prompts to return. Defaults to {@link DEFAULT_MAX_PROMPTS}. */
  maxPrompts?: number;
  /** Max number of session files to read. Defaults to {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number;
  /** Skip files larger than this byte count. Defaults to {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number;
  /** Skip individual prompts longer than this. Defaults to {@link DEFAULT_MAX_PROMPT_LENGTH}. */
  maxPromptLength?: number;
}

interface ExtractOptions {
  maxFileBytes: number;
  maxPromptLength: number;
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
 * (which is chronological per pi's session-format). Throws on filesystem
 * errors; safe-ignores per-line JSON parse errors.
 */
export function extractUserPromptsFromFile(file: string, opts: ExtractOptions): string[] {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return [];
  if (stat.size > opts.maxFileBytes) return [];

  const raw = fs.readFileSync(file, 'utf8');
  return extractUserPromptsFromText(raw, opts.maxPromptLength);
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
    if (!name.endsWith('.jsonl')) continue;
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
 * (oldest first), capped at `maxPrompts`. Returns an empty array on any
 * filesystem error - the caller treats that as "no history available."
 */
export function loadCrossSessionHistory(opts: LoadHistoryOptions): string[] {
  const maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxPromptLength = opts.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;

  if (maxPrompts <= 0 || maxFiles <= 0) return [];

  const files = listSessionFilesNewestFirst(opts.sessionDir, opts.excludeFile);
  if (files.length === 0) return [];

  // Walk newest-first and prepend each file's chronological prompts so the
  // running list is always oldest -> newest. Stop early once we already have
  // enough material; the slice at the bottom keeps the most recent.
  const collected: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    let prompts: string[];
    try {
      prompts = extractUserPromptsFromFile(file, { maxFileBytes, maxPromptLength });
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
