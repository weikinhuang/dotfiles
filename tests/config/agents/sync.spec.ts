import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const CLI = resolve(import.meta.dirname, '../../../config/agents/sync.ts');
const REPO = realpathSync(resolve(import.meta.dirname, '../../..'));

let tmp: string;

function run(
  args: string[],
  env: Record<string, string> = { PATH: process.env.PATH ?? '' },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agents-sync-cli-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('config/agents/sync.ts', () => {
  test('--help prints usage and exits 0', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: config/agents/sync.ts [command] [options]');
  });

  test('an unknown command exits 1 with usage on stderr', () => {
    const { status, stderr } = run(['sync']);
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown command: sync');
    expect(stderr).toContain('Usage:');
  });

  test('generate --check passes on the committed files', () => {
    const { status, stdout } = run(['generate', '--check']);
    expect(status).toBe(0);
    expect(stdout).toContain('generated files are up to date');
  });

  test('diff exits 1 when out of sync, apply fixes it, then diff and apply report nothing to do', () => {
    const home = join(tmp, 'home');
    const codex = join(tmp, 'codex-profile');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(codex);
    writeFileSync(join(codex, 'config.toml'), 'model = "local"\n[projects."/x y"]\ntrust_level = "trusted"\n');
    const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: codex };

    const diff = run(['diff', '--harness', 'claude', '--harness', 'codex'], env);
    expect(diff.status).toBe(1);
    expect(diff.stdout).toContain(`+ link CLAUDE.md -> ${REPO}/config/claude/global-claude.md`);
    expect(diff.stdout).toContain('~ merge config/codex/config.toml into config.toml');
    expect(diff.stdout).toContain('run: config/agents/sync.ts apply');

    const defaultCommand = run(['--harness=claude,codex'], env);
    expect(defaultCommand.stdout).toBe(diff.stdout);

    const apply = run(['apply', '--harness', 'claude,codex'], env);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain('applied, 0 conflicts');
    expect(readlinkSync(join(home, '.claude/CLAUDE.md'))).toBe(`${REPO}/config/claude/global-claude.md`);

    for (const command of ['apply', 'diff']) {
      const again = run([command, '--harness', 'claude,codex'], env);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('nothing to do');
    }
  });

  test('diff skips a harness whose home is missing', () => {
    const home = join(tmp, 'empty-home');
    mkdirSync(home);
    const { status, stdout } = run(['diff', '--harness', 'pi'], { PATH: process.env.PATH ?? '', HOME: home });
    expect(status).toBe(0);
    expect(stdout).toContain(`pi: skipped, ${home}/.pi/agent does not exist`);
    expect(stdout).toContain('nothing to do');
  });
});
