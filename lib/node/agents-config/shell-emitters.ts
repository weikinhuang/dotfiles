/**
 * Per-harness emitters for the canonical shell allowlist. Each function
 * takes a validated {@link ShellPermissionList} and returns the rules (or
 * the lines of a generated region) in that harness's own format:
 *
 *   - Claude Code: `Bash(<glob>)` strings for `permissions.allow` / `ask`.
 *   - opencode v2: ordered `{ action, resource, effect }` rule lines.
 *   - Copilot CLI: `allow shell(<identifier>[:*])` lines.
 *   - Codex CLI: Starlark `prefix_rule(...)` lines.
 *
 * Emit rules are documented in `config/agents/README.md`.
 */

import { literalPrefix, type ShellPermissionEntry, type ShellPermissionList } from './shell-permissions.ts';

export const LINE_WIDTH = 120;

/** Command that regenerates every emitted file; named in generated headers. */
export const REGENERATE_COMMAND = 'config/agents/sync.ts generate';
export const CANONICAL_LIST_PATH = 'config/agents/shell-permissions.jsonc';

/**
 * Split prose into wrap units. Backtick code spans are kept whole so a
 * span such as `find *` is never broken across lines (matching oxfmt's
 * markdown prose wrap).
 */
function wrapUnits(text: string): string[] {
  const units: string[] = [];
  let current = '';
  let inCode = false;
  for (const ch of text) {
    if (ch === '`') inCode = !inCode;
    if (ch === ' ' && !inCode) {
      if (current) units.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) units.push(current);
  return units;
}

/**
 * Greedy word wrap: the first line starts with `firstPrefix`, every
 * later line with `restPrefix`, and no line exceeds `width` unless a
 * single unit is longer than the space available.
 */
export function wrapText(text: string, firstPrefix: string, restPrefix: string, width = LINE_WIDTH): string[] {
  const lines: string[] = [];
  let line = firstPrefix;
  let empty = true;
  for (const unit of wrapUnits(text)) {
    if (!empty && line.length + 1 + unit.length > width) {
      lines.push(line);
      line = restPrefix + unit;
    } else {
      line += empty ? unit : ` ${unit}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines;
}

function commentLines(note: string | undefined, prefix: string): string[] {
  return note === undefined ? [] : wrapText(note, prefix, prefix);
}

function sharedEntries(list: ShellPermissionList): ShellPermissionEntry[] {
  return list.entries.filter((e) => e.tier === 'shared');
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export interface ClaudeRules {
  allow: string[];
  ask: string[];
}

/** Every entry (both tiers) becomes an allow rule; every `except` glob an ask rule. */
export function claudeRules(list: ShellPermissionList): ClaudeRules {
  return {
    allow: list.entries.map((e) => `Bash(${e.pattern})`),
    ask: list.entries.flatMap((e) => (e.except ?? []).map((x) => `Bash(${x})`)),
  };
}

/** Markdown bullets for `config/claude/README.md`, one per entry with a note (JSON has no comments). */
export function claudeNoteLines(list: ShellPermissionList): string[] {
  return list.entries
    .filter((e) => e.note !== undefined)
    .flatMap((e) => wrapText(`\`${e.pattern}\`: ${e.note ?? ''}`, '- ', '  '));
}

// ---------------------------------------------------------------------------
// opencode v2
// ---------------------------------------------------------------------------

function opencodeRule(resource: string, effect: 'allow' | 'ask', indent: string): string {
  return `${indent}{ "action": "shell", "resource": ${JSON.stringify(resource)}, "effect": "${effect}" },`;
}

/**
 * Lines for the generated region inside opencode's `permissions` array:
 * shared allows first, then the `except` asks (last match wins, so they
 * override the allows). Every line ends with a comma because the
 * hand-written `.env` read denies always follow the region.
 */
export function opencodeRegionLines(list: ShellPermissionList, indent = '    '): string[] {
  const shared = sharedEntries(list);
  const lines = shared.flatMap((e) => [
    ...commentLines(e.note, `${indent}// `),
    opencodeRule(e.pattern, 'allow', indent),
  ]);
  const asks = shared.flatMap((e) => e.except ?? []);
  if (asks.length > 0) {
    lines.push(
      `${indent}// \`except\` globs: ask even though an allow rule above matches (the last matching rule wins).`,
    );
    lines.push(...asks.map((x) => opencodeRule(x, 'ask', indent)));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Copilot CLI
// ---------------------------------------------------------------------------

/**
 * Copilot rule for an entry, or `undefined` when the entry is skipped:
 * `extras` tier, an `except` list (copilot has no ask-after-allow), a
 * `copilot` skip reason, or a glob with a wildcard other than a trailing
 * ` *`. `git status *` -> `shell(git status:*)`, `npm -v` ->
 * `shell(npm -v)`.
 */
export function copilotRule(entry: ShellPermissionEntry): string | undefined {
  if (entry.tier !== 'shared' || entry.except || entry.copilot) return undefined;
  const prefix = literalPrefix(entry.pattern);
  if (!prefix) return undefined;
  const id = prefix.words.join(' ');
  return prefix.trailingStar ? `shell(${id}:*)` : `shell(${id})`;
}

/** Lines for the generated region of `config/copilot/tool-permissions`. */
export function copilotRegionLines(list: ShellPermissionList): string[] {
  return list.entries.flatMap((e) => {
    const rule = copilotRule(e);
    return rule === undefined ? [] : [...commentLines(e.note, '# '), `allow ${rule}`];
  });
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

/**
 * Codex prefix-rule tokens for an entry, or `undefined` when the entry is
 * skipped: an `except` list, a `codex` skip reason, or a glob with a
 * wildcard other than a trailing ` *` (prefix rules match leading tokens
 * only, so the trailing `*` is dropped).
 */
export function codexTokens(entry: ShellPermissionEntry): string[] | undefined {
  if (entry.except || entry.codex) return undefined;
  return literalPrefix(entry.pattern)?.words;
}

const CODEX_HEADER = [
  `# Generated by \`${REGENERATE_COMMAND}\` from ${CANONICAL_LIST_PATH}. Do not edit by hand.`,
  '#',
  '# Codex prefix rules match the leading argv tokens of each command, so `["git", "status"]` allows `git status` with',
  '# any arguments. Canonical entries with `except` globs, or whose prefix rule would be broader than the glob, are left',
  '# out and keep asking.',
  '',
];

/** Full content of `config/codex/dotfiles.rules`. */
export function codexRulesFile(list: ShellPermissionList): string {
  const rules = list.entries.flatMap((e) => {
    const tokens = codexTokens(e);
    if (!tokens) return [];
    const pattern = tokens.map((t) => JSON.stringify(t)).join(', ');
    return [...commentLines(e.note, '# '), `prefix_rule(pattern=[${pattern}], decision="allow")`];
  });
  return `${[...CODEX_HEADER, ...rules].join('\n')}\n`;
}
