import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveHarnessHome } from '../../../../lib/node/agents-config/harnesses.ts';
import { JSON_CODEC } from '../../../../lib/node/agents-config/settings-merge.ts';
import { HARNESS_NAMES, type HarnessName } from '../../../../lib/node/agents-config/sync-args.ts';
import {
  applyPlan,
  backupStamp,
  countActions,
  countConflicts,
  type HarnessPlan,
  planSync,
  renderPlan,
} from '../../../../lib/node/agents-config/sync-plan.ts';
import { TOML_CODEC } from '../../../../config/agents/toml-codec.ts';

const REPO = realpathSync(resolve(import.meta.dirname, '../../../..'));
const NOW = new Date(2026, 10, 13, 9, 8, 7);
const STAMP = '20261113090807';

let tmp: string;
let home: string;

function env(): Record<string, string> {
  return { HOME: home };
}

function plan(harnesses: HarnessName[] = [...HARNESS_NAMES], force = false): HarnessPlan[] {
  return planSync({
    repoRoot: REPO,
    env: env(),
    harnesses,
    force,
    now: NOW,
    codecs: { json: JSON_CODEC, jsonc: JSON_CODEC, toml: TOML_CODEC },
  });
}

function text(plans: HarnessPlan[]): string {
  return renderPlan(plans, REPO).join('\n');
}

function makeHomes(): void {
  for (const dir of ['.claude', '.codex', '.copilot', '.config/opencode', '.pi/agent']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agents-sync-')));
  home = join(tmp, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveHarnessHome', () => {
  test('env overrides win over the HOME defaults', () => {
    const e = {
      HOME: '/h',
      CLAUDE_CONFIG_DIR: '/c',
      CODEX_HOME: '/x',
      COPILOT_HOME: '/p',
      OPENCODE_CONFIG_DIR: '/o',
      PI_CODING_AGENT_DIR: '/pi',
    };
    expect(HARNESS_NAMES.map((n) => resolveHarnessHome(n, e))).toEqual([
      '/c',
      '/x',
      '/p',
      '/o',
      '/pi',
      '/h/.agents/skills',
    ]);
    expect(HARNESS_NAMES.map((n) => resolveHarnessHome(n, { HOME: '/h', CODEX_HOME: '' }))).toEqual([
      '/h/.claude',
      '/h/.codex',
      '/h/.copilot',
      '/h/.config/opencode',
      '/h/.pi/agent',
      '/h/.agents/skills',
    ]);
    expect(resolveHarnessHome('opencode', { HOME: '/h', XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/opencode');
  });
});

describe('planSync / applyPlan', () => {
  test('missing harness homes are skipped with a note', () => {
    const plans = plan(['claude', 'codex']);
    expect(plans.map((p) => p.skipped)).toEqual([
      `${join(home, '.claude')} does not exist`,
      `${join(home, '.codex')} does not exist`,
    ]);
    expect(countActions(plans)).toBe(0);
    expect(text(plans)).toContain(`claude: skipped, ${join(home, '.claude')} does not exist`);
  });

  test('fresh homes: apply links, copies, and writes baselines; a second plan is empty', () => {
    makeHomes();
    const before = plan();
    expect(countConflicts(before)).toBe(0);
    const out = text(before);
    expect(out).toContain(`+ link CLAUDE.md -> ${REPO}/config/claude/global-claude.md`);
    expect(out).toContain('+ write settings.json (copy of config/claude/settings-baseline.json)');
    expect(out).toContain(
      '+ copy config/codex/dotfiles.rules to rules/dotfiles.rules (Codex skips symlinked .rules files)',
    );
    expect(out).toContain(`+ link tool-permissions -> ${REPO}/config/copilot/tool-permissions`);
    expect(out).toContain(`+ link APPEND_SYSTEM.md -> ${REPO}/config/pi/append-system.md`);
    expect(out).toContain(`+ link minimal-diff -> ${REPO}/config/agents/skills/minimal-diff`);

    applyPlan(before);

    expect(readlinkSync(join(home, '.codex/AGENTS.md'))).toBe(`${REPO}/config/agents/instructions.md`);
    expect(readlinkSync(join(home, '.copilot/copilot-instructions.md'))).toBe(`${REPO}/config/agents/instructions.md`);
    expect(lstatSync(join(home, '.codex/rules/dotfiles.rules')).isFile()).toBe(true);
    expect(readFileSync(join(home, '.codex/rules/dotfiles.rules'), 'utf8')).toBe(
      readFileSync(join(REPO, 'config/codex/dotfiles.rules'), 'utf8'),
    );
    // Missing live settings are the baseline verbatim (comments included).
    expect(readFileSync(join(home, '.config/opencode/opencode.jsonc'), 'utf8')).toBe(
      readFileSync(join(REPO, 'config/opencode/opencode.jsonc'), 'utf8'),
    );
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(
      readFileSync(join(REPO, 'config/codex/config.toml'), 'utf8'),
    );
    expect(lstatSync(join(home, '.agents/skills')).isDirectory()).toBe(true);

    const after = plan();
    expect(countActions(after)).toBe(0);
    expect(countConflicts(after)).toBe(0);
    expect(text(after)).toContain(`claude: ${join(home, '.claude')} (in sync)`);
  });

  test('a real file at a link target is backed up, then linked', () => {
    makeHomes();
    writeFileSync(join(home, '.pi/agent/AGENTS.md'), 'old rules\n');
    const plans = plan(['pi']);
    expect(text(plans)).toContain(
      `~ link AGENTS.md -> ${REPO}/config/agents/instructions.md (moves the existing file to AGENTS.md.dotfiles-backup-${STAMP})`,
    );
    applyPlan(plans);
    expect(readFileSync(join(home, `.pi/agent/AGENTS.md.dotfiles-backup-${STAMP}`), 'utf8')).toBe('old rules\n');
    expect(readlinkSync(join(home, '.pi/agent/AGENTS.md'))).toBe(`${REPO}/config/agents/instructions.md`);
  });

  test('a foreign symlink is a conflict without --force and replaced with it', () => {
    makeHomes();
    const other = join(tmp, 'other.md');
    writeFileSync(other, 'x');
    symlinkSync(other, join(home, '.claude/CLAUDE.md'));

    const plain = plan(['claude']);
    expect(plain[0].conflicts).toEqual([`CLAUDE.md: links to ${other}; rerun with --force to replace it`]);
    expect(text(plain)).toContain('! conflict: CLAUDE.md: links to');

    const forced = plan(['claude'], true);
    expect(forced[0].conflicts).toEqual([]);
    expect(text(forced)).toContain(`(replaces the link to ${other})`);
    applyPlan(forced);
    expect(readlinkSync(join(home, '.claude/CLAUDE.md'))).toBe(`${REPO}/config/claude/global-claude.md`);
    expect(readFileSync(other, 'utf8')).toBe('x');
  });

  test('a link through another path to the same repo file (e.g. ~/.dotfiles) counts as in sync', () => {
    makeHomes();
    const alias = join(tmp, 'dotfiles-alias');
    symlinkSync(REPO, alias);
    symlinkSync(join(alias, 'config/pi/bash-permissions-example.json'), join(home, '.pi/agent/bash-permissions.json'));
    const plans = plan(['pi']);
    expect(text(plans)).not.toContain('bash-permissions.json');
  });

  test('a real directory at a link target is never touched', () => {
    makeHomes();
    mkdirSync(join(home, '.copilot/copilot-instructions.md'));
    const plans = plan(['copilot'], true);
    expect(plans[0].conflicts).toEqual(['copilot-instructions.md: is a directory; leaving it alone']);
  });

  test('settings merge keeps live-only keys and file mode, backs up the live file', () => {
    makeHomes();
    const live = join(home, '.copilot/settings.json');
    writeFileSync(live, JSON.stringify({ enabledPlugins: {}, effortLevel: 'low', footer: { showYolo: true } }), {
      mode: 0o600,
    });
    const plans = plan(['copilot']);
    const out = text(plans);
    expect(out).toContain(
      `~ merge config/copilot/settings-baseline.json into settings.json (backs up to settings.json.dotfiles-backup-${STAMP})`,
    );
    expect(out).toContain('    ~ effortLevel: "low" -> "high"');
    expect(out).toContain('    ~ footer.showYolo: true -> false');
    expect(out).not.toContain('enabledPlugins');
    applyPlan(plans);
    const merged = JSON.parse(readFileSync(live, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(merged).slice(0, 3)).toEqual(['enabledPlugins', 'effortLevel', 'footer']);
    expect(merged.effortLevel).toBe('high');
    expect(statSync(live).mode & 0o777).toBe(0o600);
    expect(existsSync(`${live}.dotfiles-backup-${STAMP}`)).toBe(true);
    expect(countActions(plan(['copilot']))).toBe(0);
  });

  test('merging a JSONC live file warns that comments are dropped', () => {
    makeHomes();
    writeFileSync(join(home, '.config/opencode/cli.json'), '// mine\n{ "theme": { "name": "other" } }\n');
    const out = text(plan(['opencode']));
    expect(out).toContain('    warning: comments in the live file will not survive the merge');
    expect(out).toContain('    ~ theme.name: "other" -> "solarized"');
  });

  test('a symlinked or unparsable live settings file is a conflict', () => {
    makeHomes();
    symlinkSync(join(REPO, 'config/claude/settings-baseline.json'), join(home, '.claude/settings.json'));
    writeFileSync(join(home, '.pi/agent/settings.json'), '{ nope');
    const plans = plan(['claude', 'pi']);
    expect(plans[0].conflicts[0]).toMatch(/^settings\.json: is a symlink to .*; a merge would write through it/);
    expect(plans[1].conflicts[0]).toMatch(/^settings\.json: cannot parse the live file/);
  });

  test('codex rules: a stale copy is backed up and refreshed; a link to the repo file is replaced by a copy', () => {
    makeHomes();
    mkdirSync(join(home, '.codex/rules'));
    writeFileSync(join(home, '.codex/rules/dotfiles.rules'), 'stale\n');
    const stale = plan(['codex']);
    expect(text(stale)).toContain(`(content differs; backs up to dotfiles.rules.dotfiles-backup-${STAMP}`);

    rmSync(join(home, '.codex/rules/dotfiles.rules'));
    symlinkSync(join(REPO, 'config/codex/dotfiles.rules'), join(home, '.codex/rules/dotfiles.rules'));
    const linked = plan(['codex']);
    expect(countConflicts(linked)).toBe(0);
    applyPlan(linked);
    expect(lstatSync(join(home, '.codex/rules/dotfiles.rules')).isFile()).toBe(true);
  });

  test('skills: adds missing links, removes broken ones, leaves real dirs and live foreign links alone', () => {
    const skills = join(home, '.agents/skills');
    mkdirSync(join(skills, 'my-local-skill'), { recursive: true });
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(skills, 'installed-skill'));
    symlinkSync(join(tmp, 'gone'), join(skills, 'dangling'));
    symlinkSync(join(REPO, 'config/agents/skills/skill-author/'), join(skills, 'skill-author'));
    const plans = plan(['skills']);
    const out = text(plans);
    expect(out).toContain(`- remove broken link dangling -> ${join(tmp, 'gone')}`);
    expect(out).not.toContain('skill-author');
    expect(out).not.toContain('my-local-skill');
    expect(out).not.toContain('installed-skill');
    applyPlan(plans);
    const entries = readdirSync(skills).sort();
    expect(entries).toContain('my-local-skill');
    expect(entries).toContain('installed-skill');
    expect(entries).not.toContain('dangling');
    for (const name of readdirSync(join(REPO, 'config/agents/skills'))) expect(entries).toContain(name);
    expect(countActions(plan(['skills']))).toBe(0);
  });

  test('skills: a whole-directory link is a conflict', () => {
    mkdirSync(join(home, '.agents'));
    symlinkSync(join(REPO, 'config/agents/skills'), join(home, '.agents/skills'));
    expect(plan(['skills'])[0].conflicts[0]).toContain('must be a real directory');
  });

  test('env hint names the shared lines still present in a machine-local env file, without values', () => {
    makeHomes();
    writeFileSync(
      join(home, '.claude/env'),
      'export ANTHROPIC_API_KEY=sk-secret\nexport GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0="core.fsmonitor"\n',
    );
    const plans = plan(['claude']);
    const out = text(plans);
    expect(out).toContain(
      'hint: env still sets GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, which config/agents/env now provides; remove those lines by hand',
    );
    expect(out).not.toContain('sk-secret');
    applyPlan(plans);
    expect(readFileSync(join(home, '.claude/env'), 'utf8')).toContain('GIT_CONFIG_COUNT=1');
    // Hints are not actions: an otherwise in-sync harness still has nothing to do.
    expect(countActions(plan(['claude']))).toBe(0);
  });

  test('backupStamp is local YYYYmmddHHMMSS', () => {
    expect(backupStamp(NOW)).toBe(STAMP);
  });
});
