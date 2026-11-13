/**
 * What `config/agents/sync.ts diff` / `apply` manages in each harness
 * home, and where each home lives. Homes resolve from the same env vars
 * the `plugins/30-*.sh` wrappers export for `-u <profile>`, so specs can
 * point every harness at a temp dir.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HarnessName } from './sync-args.ts';

export type SettingsFormat = 'json' | 'jsonc' | 'toml';

/** `<home>/<target>` becomes a symlink to `<repo>/<source>`. */
export interface LinkItem {
  kind: 'link';
  target: string;
  source: string;
}

/** `<home>/<target>` becomes a regular-file copy of `<repo>/<source>` (for loaders that skip symlinks). */
export interface CopyItem {
  kind: 'copy';
  target: string;
  source: string;
  /** Why this is a copy rather than a link; shown in the diff. */
  reason: string;
}

/** `<home>/<target>` gets the baseline `<repo>/<source>` merged over it. */
export interface SettingsItem {
  kind: 'settings';
  target: string;
  source: string;
  format: SettingsFormat;
}

export type HarnessItem = LinkItem | CopyItem | SettingsItem;

export type ConfigHarness = Exclude<HarnessName, 'skills'>;

export const INSTRUCTIONS_SOURCE = 'config/agents/instructions.md';
export const SHARED_ENV_SOURCE = 'config/agents/env';
export const SKILLS_SOURCE = 'config/agents/skills';

const link = (target: string, source: string): LinkItem => ({ kind: 'link', target, source });
const settings = (target: string, source: string, format: SettingsFormat): SettingsItem => ({
  kind: 'settings',
  target,
  source,
  format,
});

export const HARNESS_ITEMS: Record<ConfigHarness, HarnessItem[]> = {
  claude: [
    link('CLAUDE.md', 'config/claude/global-claude.md'),
    settings('settings.json', 'config/claude/settings-baseline.json', 'json'),
  ],
  codex: [
    link('AGENTS.md', INSTRUCTIONS_SOURCE),
    {
      kind: 'copy',
      target: 'rules/dotfiles.rules',
      source: 'config/codex/dotfiles.rules',
      reason: 'Codex skips symlinked .rules files',
    },
    settings('config.toml', 'config/codex/config.toml', 'toml'),
  ],
  copilot: [
    link('copilot-instructions.md', INSTRUCTIONS_SOURCE),
    link('tool-permissions', 'config/copilot/tool-permissions'),
    settings('settings.json', 'config/copilot/settings-baseline.json', 'json'),
  ],
  opencode: [
    link('AGENTS.md', INSTRUCTIONS_SOURCE),
    settings('opencode.jsonc', 'config/opencode/opencode.jsonc', 'jsonc'),
    settings('cli.json', 'config/opencode/cli-baseline.json', 'json'),
  ],
  pi: [
    link('AGENTS.md', INSTRUCTIONS_SOURCE),
    link('APPEND_SYSTEM.md', 'config/pi/append-system.md'),
    link('bash-permissions.json', 'config/pi/bash-permissions-example.json'),
    settings('settings.json', 'config/pi/settings-baseline.json', 'json'),
  ],
};

export type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function homeDir(env: Env): string {
  return nonEmpty(env.HOME) ?? homedir();
}

/** Home directory of a harness (or `~/.agents/skills` for `skills`). */
export function resolveHarnessHome(name: HarnessName, env: Env): string {
  const home = homeDir(env);
  switch (name) {
    case 'claude':
      return nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude');
    case 'codex':
      return nonEmpty(env.CODEX_HOME) ?? join(home, '.codex');
    case 'copilot':
      return nonEmpty(env.COPILOT_HOME) ?? join(home, '.copilot');
    case 'opencode':
      return (
        nonEmpty(env.OPENCODE_CONFIG_DIR) ?? join(nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config'), 'opencode')
      );
    case 'pi':
      return nonEmpty(env.PI_CODING_AGENT_DIR) ?? join(home, '.pi', 'agent');
    case 'skills':
      return join(home, '.agents', 'skills');
  }
}
