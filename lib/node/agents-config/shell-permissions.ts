/**
 * Canonical shell-command allowlist shared by every agent harness
 * (`config/agents/shell-permissions.jsonc`): types, parsing, and
 * validation. The per-harness emitters live in `shell-emitters.ts`.
 *
 * Validation is hand-rolled (no schema library) so this module stays a
 * pure, dependency-free helper like the rest of `lib/node/`.
 */

import { parseJsonc } from '../pi/jsonc.ts';

export type ShellTier = 'shared' | 'extras';

/** Why an entry is not emitted for a harness whose matcher is coarser than the glob. */
export type CopilotSkip = 'readonly' | 'broader';
export type CodexSkip = 'broader';

export interface ShellPermissionEntry {
  /** Claude / opencode glob; `git status *` also matches the bare `git status`. */
  pattern: string;
  /** `shared` goes to every harness; `extras` only to Claude and Codex. */
  tier: ShellTier;
  /** Globs that must still ask although `pattern` allows them. */
  except?: string[];
  /** Risk note emitted as a comment next to the rule. */
  note?: string;
  /** Skip reason for Copilot. */
  copilot?: CopilotSkip;
  /** Skip reason for Codex. */
  codex?: CodexSkip;
}

export interface ShellPermissionList {
  entries: ShellPermissionEntry[];
}

const ENTRY_KEYS = new Set(['pattern', 'tier', 'except', 'note', 'copilot', 'codex']);
const TIERS: readonly string[] = ['shared', 'extras'];
const COPILOT_SKIPS: readonly string[] = ['readonly', 'broader'];
const CODEX_SKIPS: readonly string[] = ['broader'];

export class ShellPermissionsError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid shell permission list:\n  ${problems.join('\n  ')}`);
    this.name = 'ShellPermissionsError';
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGlob(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/\s{2}|[\n\t]/.test(value);
}

function validateEntry(raw: unknown, where: string, problems: string[]): ShellPermissionEntry | undefined {
  if (!isRecord(raw)) {
    problems.push(`${where}: expected an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
  }
  const { pattern, tier, except, note, copilot, codex } = raw;
  const before = problems.length;
  if (!isGlob(pattern)) {
    problems.push(`${where}: "pattern" must be a non-empty string without leading, trailing, or doubled whitespace`);
  }
  if (typeof tier !== 'string' || !TIERS.includes(tier)) {
    problems.push(`${where}: "tier" must be one of ${TIERS.join(', ')}`);
  }
  if (except !== undefined) {
    const list = Array.isArray(except) ? (except as unknown[]) : undefined;
    if (!list || list.length === 0 || !list.every(isGlob)) {
      problems.push(`${where}: "except" must be a non-empty array of glob strings`);
    } else if (typeof pattern === 'string' && list.includes(pattern)) {
      problems.push(`${where}: "except" repeats the pattern itself`);
    }
  }
  if (note !== undefined && (typeof note !== 'string' || note.trim() === '' || note.includes('\n'))) {
    problems.push(`${where}: "note" must be a non-empty single-line string`);
  }
  if (copilot !== undefined && (typeof copilot !== 'string' || !COPILOT_SKIPS.includes(copilot))) {
    problems.push(`${where}: "copilot" must be one of ${COPILOT_SKIPS.join(', ')}`);
  }
  if (codex !== undefined && (typeof codex !== 'string' || !CODEX_SKIPS.includes(codex))) {
    problems.push(`${where}: "codex" must be one of ${CODEX_SKIPS.join(', ')}`);
  }
  if (problems.length > before) return undefined;
  const entry: ShellPermissionEntry = { pattern: pattern as string, tier: tier as ShellTier };
  if (except !== undefined) entry.except = [...(except as string[])];
  if (note !== undefined) entry.note = note as string;
  if (copilot !== undefined) entry.copilot = copilot as CopilotSkip;
  if (codex !== undefined) entry.codex = codex as CodexSkip;
  return entry;
}

/** Validate an already-parsed value. Throws {@link ShellPermissionsError} listing every problem. */
export function validateShellPermissions(value: unknown): ShellPermissionList {
  const problems: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new ShellPermissionsError(['top level must be an object with an "entries" array']);
  }
  const rawEntries = value.entries as unknown[];
  for (const key of Object.keys(value)) {
    if (key !== 'entries') problems.push(`top level: unknown key "${key}"`);
  }
  const entries: ShellPermissionEntry[] = [];
  const seen = new Set<string>();
  rawEntries.forEach((raw, index) => {
    const where =
      isRecord(raw) && typeof raw.pattern === 'string' ? `entry ${index} (${raw.pattern})` : `entry ${index}`;
    const entry = validateEntry(raw, where, problems);
    if (!entry) return;
    if (seen.has(entry.pattern)) problems.push(`${where}: duplicate pattern`);
    seen.add(entry.pattern);
    entries.push(entry);
  });
  if (problems.length > 0) throw new ShellPermissionsError(problems);
  return { entries };
}

/** Parse and validate the JSONC text of `shell-permissions.jsonc`. */
export function parseShellPermissions(text: string): ShellPermissionList {
  return validateShellPermissions(parseJsonc<unknown>(text));
}

/**
 * Split a glob into its literal leading words when the only wildcard is a
 * trailing standalone `*` token: `git status *` -> `{ words: ['git',
 * 'status'], trailingStar: true }`, `pwd` -> `{ words: ['pwd'],
 * trailingStar: false }`. Returns `undefined` for globs with any other
 * wildcard (`git log*`, `yq * -i *`), which prefix-style matchers cannot
 * express.
 */
export function literalPrefix(pattern: string): { words: string[]; trailingStar: boolean } | undefined {
  const words = pattern.split(' ');
  const trailingStar = words.at(-1) === '*';
  if (trailingStar) words.pop();
  if (words.length === 0 || words.some((w) => w.includes('*') || w.includes('?'))) return undefined;
  return { words, trailingStar };
}
