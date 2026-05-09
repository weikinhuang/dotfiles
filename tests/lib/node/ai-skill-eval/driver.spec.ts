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

import { invokeDriver, parseTokens, resolveDriver } from '../../../../lib/node/ai-skill-eval/driver.ts';

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

/**
 * Async PATH-override helper. PATH is restored as soon as the callback
 * returns (synchronously), which is fine because `invokeDriver`'s underlying
 * `spawn` does the executable lookup synchronously before the Promise is
 * returned.
 */
async function withPathAsync<R>(dir: string, fn: () => Promise<R>): Promise<R> {
  const prev = process.env.PATH;
  process.env.PATH = `${join(dir, 'bin')}${delimiter}${prev ?? ''}`;
  const pending = fn();
  process.env.PATH = prev;
  return pending;
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

  test('passes exec subcommand + --skip-git-repo-check + --cd + -o and the prompt body as the last argv', async () => {
    installStub(fx.dir, 'codex', fx.stubScript('HELLO_CODEX'));
    const r = await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile),
    );

    expect(r.exitCode).toBe(0);

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

  test('passes -m <model> when model is set', async () => {
    installStub(fx.dir, 'codex', fx.stubScript('ok'));
    await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: 'gpt-5-codex' }, fx.promptFile, fx.outputFile),
    );
    const argv = readFileSync(fx.argvFile, 'utf8').trimEnd().split('\n');

    expect(argv).toContain('-m');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex');
  });

  test('captures the reply from -o into outputFile, not the stub stdout', async () => {
    installStub(fx.dir, 'codex', fx.stubScript('CODEX_FINAL_REPLY'));
    const r = await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile),
    );

    expect(r.exitCode).toBe(0);
    expect(r.bytes).toBeGreaterThan(0);

    // The stub writes its reply to the -o path; our runCodex redirects
    // stdout/stderr to /dev/null, so outputFile is the sole source.
    expect(readFileSync(fx.outputFile, 'utf8')).toBe('CODEX_FINAL_REPLY');
  });

  test('propagates non-zero exit codes', async () => {
    installStub(fx.dir, 'codex', `#!/usr/bin/env bash\nexit 7\n`);
    const r = await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile),
    );

    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
  });
});

describe('invokeDriver (timeout)', () => {
  let fx: StubFixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('SIGKILLs a sleep-5 stub when timeoutMs=300 and appends DRIVER_TIMEOUT to the output file', async () => {
    // Custom driver script that sleeps 5s then writes a reply: the timeout
    // must fire first. Use a --driver-cmd wrapper so we don't depend on PATH
    // probing of pi/claude/codex.
    const stub = join(fx.dir, 'sleep-stub.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nsleep 5\nprintf 'LATE_REPLY\\n'\n`);
    chmodSync(stub, 0o755);

    const t0 = Date.now();
    const r = await invokeDriver(
      { driver: null, driverCmd: stub, model: null, timeoutMs: 300 },
      fx.promptFile,
      fx.outputFile,
    );
    const elapsedMs = Date.now() - t0;

    expect(r.timedOut).toBe(true);
    // Elapsed time: timeoutMs (300ms) + SIGTERM→SIGKILL grace (up to 2s) +
    // small event-loop overhead. Sleep would otherwise block ~5000ms.
    expect(elapsedMs).toBeLessThan(3000);
    expect(readFileSync(fx.outputFile, 'utf8')).toContain('DRIVER_TIMEOUT');
    expect(readFileSync(fx.outputFile, 'utf8')).not.toContain('LATE_REPLY');
  }, 10_000);

  test('does not time out when the child finishes before timeoutMs', async () => {
    const stub = join(fx.dir, 'fast-stub.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf 'FAST_REPLY\\n'\n`);
    chmodSync(stub, 0o755);

    const r = await invokeDriver(
      { driver: null, driverCmd: stub, model: null, timeoutMs: 5000 },
      fx.promptFile,
      fx.outputFile,
    );

    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(fx.outputFile, 'utf8')).toContain('FAST_REPLY');
    expect(readFileSync(fx.outputFile, 'utf8')).not.toContain('DRIVER_TIMEOUT');
  });
});

describe('parseTokens', () => {
  test('codex-style "tokens used: 12,345" is parsed (comma stripped)', () => {
    expect(parseTokens('session created\ntokens used: 12,345\ndone')).toBe(12345);
  });

  test('pi-style "tokens: 4200" suffix is parsed', () => {
    expect(parseTokens('TRIGGER: yes\n...\n-- tokens: 4200 --')).toBe(4200);
  });

  test('generic "total tokens: 900" footer is parsed', () => {
    expect(parseTokens('reply body\ntotal tokens: 900')).toBe(900);
  });

  test('returns null when no known pattern matches', () => {
    expect(parseTokens('just a reply, no metrics at all')).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(parseTokens('')).toBeNull();
  });
});

describe('invokeDriver token capture', () => {
  let fx: StubFixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('custom driver: tokens parsed from the stdout captured into outputFile', async () => {
    // Custom driver writes the reply (plus a usage footer) to stdout. The
    // driver merges stdout+stderr into outputFile, so parseTokens sees the
    // footer through captureTokens(custom).
    const stub = join(fx.dir, 'pi-like.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf 'TRIGGER: yes\\nREASON: r\\nNEXT_STEP: s\\ntokens: 4242\\n'\n`);
    chmodSync(stub, 0o755);

    const r = await invokeDriver(
      { driver: null, driverCmd: stub, model: null, timeoutMs: null },
      fx.promptFile,
      fx.outputFile,
    );

    expect(r.tokens).toBe(4242);
    expect(r.toolCalls).toBeNull();
  });

  test('codex driver: stdout captured into <outputFile>.log sidecar + parsed for tokens; outputFile holds the -o reply only', async () => {
    // Stub a codex that prints a decorated log to stdout AND writes the
    // reply into -o FILE. runCodex now routes stdout to a `<outputFile>.log`
    // sidecar so captureTokens('codex') can parse it; stderr goes to
    // /dev/null.
    const script =
      `#!/usr/bin/env bash\nset -euo pipefail\n` +
      // Decorated log on stdout (what codex exec normally prints).
      `printf 'session_id: abc\\ntokens used: 9,876\\n'\n` +
      // Extract -o FILE.
      `out=''\n` +
      `while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\n` +
      `printf 'CODEX_REPLY' > "$out"\n`;
    installStub(fx.dir, 'codex', script);

    const r = await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: null, timeoutMs: null }, fx.promptFile, fx.outputFile),
    );

    expect(r.exitCode).toBe(0);
    // Reply is still the -o content (not the decorated log).
    expect(readFileSync(fx.outputFile, 'utf8')).toBe('CODEX_REPLY');

    // Sidecar log exists and carries the decorated stdout.
    const sidecar = readFileSync(`${fx.outputFile}.log`, 'utf8');

    expect(sidecar).toContain('tokens used: 9,876');
    // Tokens surfaced on the DriverResult from the sidecar parse.
    expect(r.tokens).toBe(9876);
  });

  test('returns durationSec as a float (2-decimal precision)', async () => {
    installStub(fx.dir, 'codex', fx.stubScript('ok'));
    const r = await withPathAsync(fx.dir, () =>
      invokeDriver({ driver: 'codex', driverCmd: null, model: null }, fx.promptFile, fx.outputFile),
    );

    expect(typeof r.durationSec).toBe('number');
    // Fast stub — duration should be under 2 seconds but non-negative.
    expect(r.durationSec).toBeGreaterThanOrEqual(0);
    expect(r.durationSec).toBeLessThan(2);
    // 2-decimal rounding: no more than 2 fractional digits in the text form.
    expect(`${r.durationSec}`.replace(/^-?\d+(?:\.(\d+))?$/, '$1').length).toBeLessThanOrEqual(2);
  });
});
