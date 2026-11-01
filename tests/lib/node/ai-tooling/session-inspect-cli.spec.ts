import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const CLI = resolve(import.meta.dirname, '../../../../lib/node/ai-tooling/session-inspect-cli.ts');
const PII = 'PII_MARKER_cli_91c2';
const SESSION_ID = '019f0109-aaaa-7bbb-8ccc-ddddeeeeffff';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; sessions: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), `inspect-${PII}-`));
  roots.push(root);
  const sessions = join(root, 'sessions');
  const project = join(sessions, `--Users-${PII}--`);
  mkdirSync(project, { recursive: true });
  const file = join(project, `2026-11-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
  const lines = [
    { type: 'session', id: SESSION_ID, cwd: `/Users/${PII}` },
    { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: `${PII} opening` } },
    {
      id: 'a1',
      parentId: 'u1',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${PII} reply` }],
        provider: 'local',
        model: 'gemma',
        usage: { input: 900, output: 20 },
        stopReason: 'stop',
      },
    },
    {
      id: 'r1',
      parentId: 'a1',
      type: 'custom',
      customType: 'roleplay-context-recap',
      data: { recap: `${PII} recap`, cast: PII, applied: true, mode: 'budget' },
    },
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{"broken":"${PII}`);
  return { root, sessions, file };
}

function run(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('ai-session-inspect: every output mode omits session text and the path', () => {
  const { file } = fixture();
  for (const flags of [[], ['--all'], ['--json'], ['--json', '--no-ids'], ['--turns', '--recaps', '--snapshots']]) {
    const result = run([file, ...flags]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(PII);
  }
  const report = JSON.parse(run([file, '--json']).stdout) as {
    privacy: string;
    sessionId: string;
    totals: { userTurns: number };
  };
  expect(report).toMatchObject({ privacy: 'metadata-only', sessionId: SESSION_ID, totals: { userTurns: 1 } });
});

test('ai-session-inspect: resolves an id prefix or the newest session under --user-dir', () => {
  const { sessions } = fixture();
  for (const args of [[SESSION_ID.slice(0, 8), '--user-dir', sessions], [`--user-dir=${sessions}`], ['-u', sessions]]) {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`session ${SESSION_ID}`);
    expect(result.stdout).not.toContain(PII);
  }
});

test('ai-session-inspect: errors are authored text that never echo paths or content', () => {
  const { root, sessions } = fixture();
  const missing = run(['nope-not-a-session', '--user-dir', sessions]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toBe('ai-session-inspect: no matching pi session found\n');
  expect(run(['--bogus']).stderr).toContain('unknown argument: --bogus');
  expect(run(['--user-dir']).stderr).toContain('missing value for --user-dir');
  expect(run(['a', 'b']).stderr).toContain('only one session selector');
  const unreadable = join(root, 'dir.jsonl');
  mkdirSync(unreadable);
  const result = run(['missing', '--user-dir', unreadable]);
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain(PII);
  expect(run(['--help']).stdout).toContain('Usage: ai-session-inspect');
});
