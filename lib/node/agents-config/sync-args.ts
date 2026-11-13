/**
 * Argument parsing for `config/agents/sync.ts`. Returns a parsed command
 * or throws {@link SyncArgsError}; the CLI owns printing and exit codes.
 */

/** Harness groups `diff` / `apply` manage; `skills` is the shared `~/.agents/skills` link farm. */
export const HARNESS_NAMES = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'skills'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export type SyncCommand =
  | { command: 'help' }
  | { command: 'generate'; check: boolean }
  | { command: 'diff' | 'apply'; harnesses: HarnessName[]; force: boolean };

export class SyncArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncArgsError';
  }
}

export const SYNC_HELP = `Usage: config/agents/sync.ts [command] [options]

Commands:
  diff (default)    Print every link, copy, and settings change that apply would make; exit 1 when
                    anything is out of sync or conflicts. Writes nothing.
  apply             Make the changes diff prints. Real files are backed up to
                    <name>.dotfiles-backup-<YYYYmmddHHMMSS> first; a symlink pointing elsewhere is
                    replaced only with --force. Exit 1 when a conflict is left.
  generate          Rewrite the committed per-harness files from config/agents/shell-permissions.jsonc
                    (Claude permissions.allow / ask, opencode and Copilot generated regions, Codex
                    dotfiles.rules, the notes region in config/claude/README.md).

Options:
  --harness NAME    With diff / apply: only manage NAME (repeatable or comma-separated): claude, codex,
                    copilot, opencode, pi, skills. Default: all of them.
  --force           With diff / apply: replace symlinks that point somewhere else.
  --check           With generate: write nothing; exit 1 and list the files that are out of date.
  -h, --help        Show this help.

Harness homes come from CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME, OPENCODE_CONFIG_DIR (else
\${XDG_CONFIG_HOME:-~/.config}/opencode), and PI_CODING_AGENT_DIR, falling back to the default
locations under HOME; a harness whose home does not exist is skipped.`;

function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

function addHarnesses(out: HarnessName[], value: string): void {
  for (const name of value.split(',')) {
    if (!isHarnessName(name)) {
      throw new SyncArgsError(`Unknown harness: ${name} (expected one of ${HARNESS_NAMES.join(', ')})`);
    }
    if (!out.includes(name)) out.push(name);
  }
}

export function parseSyncArgs(argv: string[]): SyncCommand {
  let command: 'generate' | 'diff' | 'apply' | undefined;
  let check = false;
  let force = false;
  let harnessFlag = false;
  const harnesses: HarnessName[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { command: 'help' };
    if (arg === '--check') {
      check = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--harness') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new SyncArgsError('Missing value for --harness');
      addHarnesses(harnesses, value);
      harnessFlag = true;
      i++;
    } else if (arg.startsWith('--harness=')) {
      addHarnesses(harnesses, arg.slice('--harness='.length));
      harnessFlag = true;
    } else if (arg.startsWith('-')) {
      throw new SyncArgsError(`Unknown option: ${arg}`);
    } else if (command === undefined && (arg === 'generate' || arg === 'diff' || arg === 'apply')) {
      command = arg;
    } else if (command === undefined) {
      throw new SyncArgsError(`Unknown command: ${arg}`);
    } else {
      throw new SyncArgsError(`Unexpected argument: ${arg}`);
    }
  }
  if (command === 'generate') {
    if (force) throw new SyncArgsError('--force only applies to diff / apply');
    if (harnessFlag) throw new SyncArgsError('--harness only applies to diff / apply');
    return { command, check };
  }
  if (check) throw new SyncArgsError('--check only applies to generate');
  return { command: command ?? 'diff', harnesses: harnesses.length > 0 ? harnesses : [...HARNESS_NAMES], force };
}
