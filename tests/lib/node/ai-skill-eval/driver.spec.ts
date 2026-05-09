// Tests for lib/node/ai-skill-eval/driver.ts.
//
// The driver functions shell out to real binaries (`pi`, `claude`, `codex`)
// via spawnSync. Rather than mock node:child_process we drop stub scripts
// into a temp dir and prepend that dir to PATH; each stub writes its
// received argv to a side-channel file we can assert on.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { invokeDriver, resolveDriver } from '../../../../lib/node/ai-skill-eval/driver.ts';

interface StubFixture {
  dir: string;
  promptFile: string;
  outputFile: string;
  argvFile: string;
  stubScript: (reply: string) => string;
}

function makeFixture(): StubFixture {
  const dir = mkdtempSync(join(tmpdir(), 'ai-skill-eval-driver-'));
  const promptFile = join(dir, 'prompt.txt');
  writeFileSync(promptFile, 'the prompt body');
  const outputFile = join(dir, 'output.txt');
  const argvFile = join(dir, 'argv.txt');

  // Returns a bash script body that records the stub's argv (one per line)
  // and any requested `-o` target, then writes the given `reply`.
  const stubScript = (reply: string): string =>
    `#!/usr/bin/env bash\n` +
    `: > '${argvFile}'\n` +
    `for a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\n` +
    // Capture -o FILE (codex writes its reply there).
    `out=''\n` +
    `while [[ $# -gt 0 ]]; do\n` +
    `  case "$1" in\n` +
    `    -o) out="$2"; shift 2 ;;\n` +
    `    *)  shift ;;\n` +
    `  esac\n` +
    `done\n` +
    `if [[ -n "$out" ]]; then\n` +
    `  printf '%s' ${JSON.stringify(reply)} > "$out"\n` +
    `else\n` +
    `  printf '%s' ${JSON.stringify(reply)}\n` +
    `fi\n`;

  return { dir, promptFile, outputFile, argvFile, stubScript };
}

function installStub(dir: string, name: string, body: string): void {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function withPath(dir: string, fn: () => void): void {
  const prev = process.env.PATH;
  process.env.PATH = `${join(dir, 'bin')}${delimiter}${prev ?? ''}`;
  try {
    fn();
  } finally {
    process.env.PATH = prev;
  }
}

describe('resolveDriver', () => {
  const savedEnv = process.env.AI_SKILL_EVAL_DRIVER;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AI_SKILL_EVAL_DRIVER;
    else process.env.AI_SKILL_EVAL_DRIVER = savedEnv;
  });

  test('explicit cfg.driver wins over everything', () => {
    process.env.AI_SKILL_EVAL_DRIVER = 'pi';

    expect(resolveDriver({ driver: 'codex', driverCmd: null, model: null })).toBe('codex');
  });

  test('AI_SKILL_EVAL_DRIVER=codex is accepted', () => {
    process.env.AI_SKILL_EVAL_DRIVER = 'codex';

    expect(resolveDriver({ driver: null, driverCmd: null, model: null })).toBe('codex');
  });

  test('AI_SKILL_EVAL_DRIVER=claude is accepted', () => {
    process.env.AI_SKILL_EVAL_DRIVER = 'claude';

    expect(resolveDriver({ driver: null, driverCmd: null, model: null })).toBe('claude');
  });

  test('unknown AI_SKILL_EVAL_DRIVER values are ignored (falls through to PATH probe)', () => {
    process.env.AI_SKILL_EVAL_DRIVER = 'bogus';
    // Result depends on what's on the host PATH; assert only that it's one of
    // the known kinds and not 'bogus'.
    const r = resolveDriver({ driver: null, driverCmd: null, model: null });

    expect(['pi', 'claude', 'codex']).toContain(r);
  });
});

describe('invokeDriver (codex)', () => {
  let fx: StubFixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('passes exec subcommand + --skip-git-repo-check + --cd + -o and the prompt body as the last argv', () => {
    installStub(fx.dir, 'codex', fx.stubScript('HELLO_CODEX'));
    withPath(fx.dir, () => {
      const r = invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile);

      expect(r.exitCode).toBe(0);
    });

    const argv = readFileSync(fx.argvFile, 'utf8').trimEnd().split('\n');

    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('-o');
    expect(argv[argv.indexOf('-o') + 1]).toBe(fx.outputFile);
    expect(argv).toContain('--cd');
    // No sandbox flag: we let codex use its config default.
    expect(argv).not.toContain('-s');
    // Prompt body is the last positional argv.
    expect(argv[argv.length - 1]).toBe('the prompt body');
    // No -m when model is null.
    expect(argv).not.toContain('-m');
  });

  test('passes -m <model> when model is set', () => {
    installStub(fx.dir, 'codex', fx.stubScript('ok'));
    withPath(fx.dir, () => {
      invokeDriver({ driver: 'codex', driverCmd: null, model: 'gpt-5-codex' }, fx.promptFile, fx.outputFile);
    });
    const argv = readFileSync(fx.argvFile, 'utf8').trimEnd().split('\n');

    expect(argv).toContain('-m');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex');
  });

  test('captures the reply from -o into outputFile, not the stub stdout', () => {
    installStub(fx.dir, 'codex', fx.stubScript('CODEX_FINAL_REPLY'));
    withPath(fx.dir, () => {
      const r = invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile);

      expect(r.exitCode).toBe(0);
      expect(r.bytes).toBeGreaterThan(0);
    });

    // The stub writes its reply to the -o path; our runCodex redirects
    // stdout/stderr to /dev/null, so outputFile is the sole source.
    expect(readFileSync(fx.outputFile, 'utf8')).toBe('CODEX_FINAL_REPLY');
  });

  test('propagates non-zero exit codes', () => {
    installStub(fx.dir, 'codex', `#!/usr/bin/env bash\nexit 7\n`);
    withPath(fx.dir, () => {
      const r = invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile);

      expect(r.exitCode).toBe(7);
    });
  });
});
