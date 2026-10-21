/**
 * `/agents` command surface: USAGE text, argument parsing, and the
 * completion spec. Pure module so the extension-shell handler, its
 * `--help` path, and the vitest specs share one source of truth.
 *
 * Bare `/agents` opens the running-children view (the thing you most
 * often want mid-task); `list` shows the loaded agent definitions.
 */

import { type SubverbSpec } from '../commands/complete.ts';

export const AGENTS_USAGE = [
  'Usage: /agents [running|list|show <name>|reload]',
  '',
  'With no args (or `running`), open a live overlay of background',
  'sub-agents (auto-refreshing). `list` shows the loaded agent',
  'definitions, `show <name>` prints one definition, and `reload`',
  're-scans the agent directories and reports what loaded.',
].join('\n');

export type AgentsCommand =
  | { verb: 'running' }
  | { verb: 'list' }
  | { verb: 'reload' }
  | { verb: 'show'; name: string }
  | { verb: 'invalid' };

/**
 * Parse the raw `/agents` argument string. Empty args mean `running`;
 * `show` requires exactly one agent name. Anything else is `invalid`
 * (the handler prints {@link AGENTS_USAGE}).
 */
export function parseAgentsCommand(raw: string | undefined): AgentsCommand {
  const args = (raw ?? '').trim();
  if (args === '' || args === 'running') return { verb: 'running' };
  if (args === 'list') return { verb: 'list' };
  if (args === 'reload') return { verb: 'reload' };
  const show = /^show\s+(\S+)$/.exec(args);
  if (show) return { verb: 'show', name: show[1] };
  return { verb: 'invalid' };
}

/**
 * Completion spec for `/agents`, handed to `completeSubverbs`. `show`
 * completes loaded agent names via `describeAgent` (name -> description).
 */
export function agentsSubverbSpec(nameOrder: readonly string[], describeAgent: (name: string) => string): SubverbSpec {
  return {
    running: { description: 'Live overlay of background sub-agents (default)' },
    list: { description: 'List loaded agent definitions' },
    show: {
      description: 'Show full frontmatter + body for an agent',
      args: (tail) =>
        nameOrder.filter((n) => n.startsWith(tail)).map((n) => ({ label: n, description: describeAgent(n) })),
    },
    reload: { description: 'Re-scan agent directories and report what loaded' },
  };
}
