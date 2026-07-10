/**
 * File-based prompt-guidance overrides for the `roleplay` extension.
 *
 * The task-builders (`summarize.ts`, `timeline.ts`, `capture.ts`,
 * `event.ts`) split their prompt into an EDITABLE guidance section and a
 * FIXED, builder-owned contract (JSON shape, `[]` / `null` sentinels, the
 * `MAX_*` caps). This module resolves a downstream project's replacement
 * for the *guidance* section only - the contract + data stay owned by the
 * builder, so an override can never break the parsers.
 *
 * Resolution mirrors the child-model settings cascade in `one-shot.ts`:
 * project scope wins over user scope, first non-empty file wins, and a
 * missing / empty / unreadable file resolves to `null` so the caller falls
 * back to the shipped default guidance. Non-load-bearing: with no override
 * files anywhere on disk, every builder produces the exact prompt it does
 * today.
 *
 *   1. `<cwd>/.pi/roleplay/prompts/<name>.md`      (project scope)
 *   2. `<root>/prompts/<name>.md`                  (user scope; `root`
 *      defaults to `roleplayRoot()`, so it follows `PI_ROLEPLAY_ROOT`)
 *
 * No pi imports.
 */

import { join } from 'node:path';

import { readTextOrNull } from '../fs-safe.ts';
import { envTruthy } from '../parse-env.ts';
import { piProjectPath } from '../pi-paths.ts';
import { roleplayRoot } from './paths.ts';

/** The overridable prompt slots, one per task-builder. */
export type RoleplayPromptName = 'summary' | 'timeline' | 'facts' | 'event';

export interface PromptOverride {
  /** Trimmed override guidance text. */
  text: string;
  /** Absolute path of the file that produced it - useful for diagnostics. */
  source: string;
}

export interface ResolvePromptOverrideOpts {
  cwd: string;
  /**
   * Store root for the user-scope layer. Defaults to `roleplayRoot()`
   * (honours `PI_ROLEPLAY_ROOT`). Injectable so tests can point at a temp
   * dir without touching the environment.
   */
  root?: string;
}

/**
 * Resolve the guidance override for `name`, or `null` when none applies.
 * Project scope (`<cwd>/.pi/roleplay/prompts/<name>.md`) is tried before
 * user scope (`<root>/prompts/<name>.md`); the first file with non-blank
 * content wins. A missing / unreadable / whitespace-only file is skipped,
 * so the caller uses the shipped default guidance.
 *
 * The `PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES` kill switch forces `null`
 * regardless of what is on disk - a one-flag way to compare a custom
 * prompt against stock, and a safety hatch if an override misbehaves.
 */
export function resolvePromptOverride(
  name: RoleplayPromptName,
  opts: ResolvePromptOverrideOpts,
): PromptOverride | null {
  if (envTruthy(process.env.PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES)) return null;
  const root = opts.root ?? roleplayRoot();
  const file = `${name}.md`;
  const candidates = [piProjectPath(opts.cwd, 'roleplay', 'prompts', file), join(root, 'prompts', file)];
  for (const path of candidates) {
    const raw = readTextOrNull(path);
    if (raw === null) continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    return { text, source: path };
  }
  return null;
}

/**
 * Convenience for the common call shape: resolve the override and return
 * just its trimmed text (or `undefined` when none), matching the optional
 * `guidance?` param every builder accepts.
 */
export function resolvePromptGuidance(name: RoleplayPromptName, opts: ResolvePromptOverrideOpts): string | undefined {
  return resolvePromptOverride(name, opts)?.text;
}
