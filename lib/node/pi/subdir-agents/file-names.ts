/**
 * Pure parser for the `PI_SUBDIR_AGENTS_NAMES` override.
 *
 * The subdir-agents extension lets the user override which context
 * filenames to discover (default `AGENTS.md`, `CLAUDE.md`) via a
 * comma-separated env var. Extracted here so the parse - split, trim,
 * drop-empty, fall back to the default when nothing survives - is
 * unit-testable without the pi runtime. The extension shell reads the
 * env var and passes its raw value in.
 */

import { DEFAULT_CONTEXT_FILE_NAMES } from '../subdir-agents.ts';

/**
 * Parse the comma-separated `raw` override into a list of context
 * filenames. Returns {@link DEFAULT_CONTEXT_FILE_NAMES} when `raw` is
 * missing/empty or contains only blank entries.
 */
export function parseFileNames(raw: string | undefined): readonly string[] {
  if (!raw) return DEFAULT_CONTEXT_FILE_NAMES;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : DEFAULT_CONTEXT_FILE_NAMES;
}
