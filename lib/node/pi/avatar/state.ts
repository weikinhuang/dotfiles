/**
 * Pure state-machine helpers for the `avatar` extension.
 *
 * The timer-driven `Animator` lives in the extension shell
 * (`config/pi/extensions/avatar.ts`) because it needs `setTimeout` /
 * the renderer; only the pure decision bits live here so they can be
 * unit-tested.
 */

import type { ActivityState } from './types.ts';

/**
 * Map a tool name to the activity sprite state it should drive:
 *   - `read`   - the `read` tool
 *   - `write`  - the write-family tools (`write` / `edit` / `apply_patch`)
 *   - `debug`  - code-investigation tools (`grep` / `glob` / search / find / list)
 *   - `fetch`  - network tools (`fetch` / web fetch / web search)
 *   - `plan`   - planning tools (`todo_write` / `update_plan`)
 *   - `tool`   - everything else (the generic state)
 */
export function toolNameToState(toolName: string): ActivityState {
  switch (toolName) {
    case 'read':
      return 'read';
    case 'write':
    case 'edit':
    case 'apply_patch':
      return 'write';
    case 'grep':
    case 'glob':
    case 'search':
    case 'codebase_search':
    case 'find':
    case 'list':
    case 'ls':
    case 'list_dir':
      return 'debug';
    case 'fetch':
    case 'web_fetch':
    case 'webfetch':
    case 'web_search':
    case 'websearch':
      return 'fetch';
    case 'todo_write':
    case 'todowrite':
    case 'update_plan':
    case 'plan':
      return 'plan';
    default:
      return 'tool';
  }
}

/** Network helpers (basenames) that drive the `fetch` state from a bash command. */
const FETCH_COMMANDS = new Set(['ai-fetch-web']);

/**
 * Investigation/inspection commands (basenames) that drive the `debug` state:
 * code/text search, file finding, listing, and content viewers.
 */
const DEBUG_COMMANDS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'find',
  'fd',
  'ls',
  'tree',
  'cat',
  'bat',
  'head',
  'tail',
  'less',
  'more',
]);

/** `git` subcommands (as `git <sub>`) that are read-only inspection -> `debug`. */
const DEBUG_GIT = new Set(['git status', 'git log', 'git diff', 'git show', 'git blame']);

/** Command-prefix wrappers to look past when finding the real command. */
const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nice', 'xargs']);

/** Strip a leading directory path from a command token (`/usr/bin/rg` -> `rg`). */
function basename(token: string): string {
  const slash = token.lastIndexOf('/');
  return (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
}

/**
 * The leading command of each pipeline/sequence segment, lowercased and
 * path-stripped, skipping `VAR=val` prefixes and wrapper commands. For `git`,
 * also yields `git <subcommand>` so read-only subcommands can be matched.
 */
function leadingCommands(command: string): string[] {
  const cmds: string[] = [];
  for (const segment of command.split(/[\n;]+|\|\|?|&&?/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(basename(tokens[i])))) i++;
    if (i >= tokens.length) continue;
    const head = basename(tokens[i]);
    cmds.push(head);
    if (head === 'git' && i + 1 < tokens.length) cmds.push(`git ${tokens[i + 1].toLowerCase()}`);
  }
  return cmds;
}

/**
 * Map a `bash` command to a more specific activity state when it runs a
 * recognizable helper, or `null` to fall back to the generic `bash` mapping.
 * Network helpers (`ai-fetch-web`) drive `fetch`; search/find/list/inspect
 * commands (and read-only `git` subcommands) drive `debug`.
 */
export function bashCommandToState(command: string): ActivityState | null {
  const cmds = leadingCommands(command);
  if (cmds.some((cmd) => FETCH_COMMANDS.has(cmd))) return 'fetch';
  if (cmds.some((cmd) => DEBUG_COMMANDS.has(cmd) || DEBUG_GIT.has(cmd))) return 'debug';
  return null;
}

/**
 * Target talk-animation duration (ms) for `wordCount` words at
 * `readingSpeed` words/sec. Returns `0` when `readingSpeed` is
 * non-positive so the caller falls straight through to idle.
 */
export function talkDurationMs(wordCount: number, readingSpeed: number): number {
  if (!Number.isFinite(readingSpeed) || readingSpeed <= 0) return 0;
  return (wordCount / readingSpeed) * 1000;
}

/** Count whitespace-delimited words in `text` (used to pace talk). */
export function countWords(text: string): number {
  let count = 0;
  for (const part of text.split(/\s+/)) {
    if (part.length > 0) count++;
  }
  return count;
}

/**
 * Render a per-session tool-call tally as `name(count)` tokens for the
 * avatar info panel, e.g. `bash(3) read(2) edit(1)`. Sorted by descending
 * count, then name ascending. Zero / negative counts are dropped; an empty
 * tally renders as `no tool calls`.
 */
export function formatToolTally(counts: ReadonlyMap<string, number>): string {
  const entries = [...counts.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return 'no tool calls';
  entries.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
  return entries.map(([name, count]) => `${name}(${count})`).join(' ');
}
