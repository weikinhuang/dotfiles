/**
 * Tests for lib/node/pi/bash-exit-watchdog.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_SUPPRESSIONS,
  formatWarning,
  loadConfig,
  parseExitCode,
  shouldSuppress,
  type SuppressRule,
} from '../../../../lib/node/pi/bash-exit-watchdog.ts';

// ──────────────────────────────────────────────────────────────────────
// parseExitCode
// ──────────────────────────────────────────────────────────────────────

describe('parseExitCode', () => {
  test("matches pi's canonical trailing marker", () => {
    const content = 'some output\n\nCommand exited with code 1';

    expect(parseExitCode(content)).toBe(1);
  });

  test('handles negative exit codes (signal kills get reported as negatives on some shells)', () => {
    expect(parseExitCode('x\n\nCommand exited with code -11')).toBe(-11);
  });

  test('returns undefined when marker is absent', () => {
    expect(parseExitCode('some output\nno marker here')).toBeUndefined();
  });

  test('ignores bare "Command exited" text inside command output (requires \\n\\n prefix)', () => {
    // If a command itself echoes "Command exited with code 2" mid-stream,
    // we should NOT treat it as pi's marker.
    expect(parseExitCode('log line: Command exited with code 2\nthen more')).toBeUndefined();
  });

  test('tolerates trailing whitespace', () => {
    expect(parseExitCode('x\n\nCommand exited with code 2   \n')).toBe(2);
  });

  test('returns undefined on non-string input', () => {
    expect(parseExitCode(undefined as unknown as string)).toBeUndefined();
    expect(parseExitCode(null as unknown as string)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// shouldSuppress
// ──────────────────────────────────────────────────────────────────────

describe('shouldSuppress with defaults', () => {
  test('grep exit 1 is suppressed', () => {
    expect(shouldSuppress('grep foo file.txt', 1, DEFAULT_SUPPRESSIONS)).toBe(true);
  });

  test('grep exit 2 (file not found) is NOT suppressed — that IS a failure', () => {
    expect(shouldSuppress('grep foo missing.txt', 2, DEFAULT_SUPPRESSIONS)).toBe(false);
  });

  test('rg/ag/ack exit 1 is suppressed', () => {
    expect(shouldSuppress('rg --glob "*.ts" pattern', 1, DEFAULT_SUPPRESSIONS)).toBe(true);
    expect(shouldSuppress('ag pattern', 1, DEFAULT_SUPPRESSIONS)).toBe(true);
  });

  test('diff exit 1 is suppressed, exit 2 is not', () => {
    expect(shouldSuppress('diff -u a b', 1, DEFAULT_SUPPRESSIONS)).toBe(true);
    expect(shouldSuppress('diff -u a b', 2, DEFAULT_SUPPRESSIONS)).toBe(false);
  });

  test('random command with non-zero exit is NOT suppressed', () => {
    expect(shouldSuppress('./deploy.sh', 1, DEFAULT_SUPPRESSIONS)).toBe(false);
    expect(shouldSuppress('npm test', 1, DEFAULT_SUPPRESSIONS)).toBe(false);
  });

  test('grep embedded in a pipeline still suppresses on exit 1', () => {
    // `cmd | grep foo` returns the pipeline exit status which bash reports
    // as the last stage's code by default.
    expect(shouldSuppress('cat x | grep foo', 1, DEFAULT_SUPPRESSIONS)).toBe(true);
  });

  test('does not falsely match words containing "grep" as substring', () => {
    expect(shouldSuppress('./fingerprep-check', 1, DEFAULT_SUPPRESSIONS)).toBe(false);
    expect(shouldSuppress('grepzilla foo', 1, DEFAULT_SUPPRESSIONS)).toBe(false);
  });
});

describe('shouldSuppress with custom rules', () => {
  test('rule without exitCodes suppresses ANY non-zero exit for matching commands', () => {
    const rules: SuppressRule[] = [{ commandPattern: '^make\\b' }];

    expect(shouldSuppress('make install', 2, rules)).toBe(true);
    expect(shouldSuppress('make install', 99, rules)).toBe(true);
    expect(shouldSuppress('cmake build', 1, rules)).toBe(false);
  });

  test('malformed regex is skipped silently, not thrown', () => {
    const rules: SuppressRule[] = [
      { commandPattern: '[invalid(' }, // bad regex
      { commandPattern: '^echo' },
    ];

    // Should not throw; second rule still evaluated.
    expect(shouldSuppress('echo hi', 1, rules)).toBe(true);
  });

  test('empty rules list never suppresses', () => {
    expect(shouldSuppress('whatever', 1, [])).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatWarning
// ──────────────────────────────────────────────────────────────────────

describe('formatWarning', () => {
  test('includes exit code and command snippet', () => {
    const w = formatWarning(2, 'npm test');

    expect(w).toContain('exit code 2');
    expect(w).toContain('npm test');
    expect(w).toContain('Do NOT');
  });

  test('truncates long commands', () => {
    const long = 'bash -c ' + 'x'.repeat(300);
    const w = formatWarning(1, long);

    // Snippet is capped at ~120 chars, so warning has a bounded length.
    expect(w.length).toBeLessThan(350);
    expect(w).toContain('…');
  });

  test('collapses whitespace and newlines in the command snippet', () => {
    const cmd = 'bash\n  -c\n  "echo foo"';

    expect(formatWarning(1, cmd)).toContain('bash -c "echo foo"');
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadConfig
// ──────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let workdir: string;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    workdir = join(tmpdir(), `bew-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    home = join(workdir, 'home');
    cwd = join(workdir, 'proj');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test('no config files → defaults only', () => {
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.suppress).toEqual(DEFAULT_SUPPRESSIONS);
    expect(warnings).toEqual([]);
  });

  test('user rules extend defaults, do not replace', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'exit-watchdog.json'),
      JSON.stringify({ suppress: [{ commandPattern: '^./migrate', exitCodes: [3] }] }),
    );
    const { config } = loadConfig(cwd, home);

    expect(config.suppress.length).toBe(DEFAULT_SUPPRESSIONS.length + 1);
    expect(config.suppress.at(-1)).toEqual({ commandPattern: '^./migrate', exitCodes: [3] });
  });

  test('project rules further extend', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'exit-watchdog.json'),
      JSON.stringify({ suppress: [{ commandPattern: '^./a' }] }),
    );
    writeFileSync(join(cwd, '.pi', 'exit-watchdog.json'), JSON.stringify({ suppress: [{ commandPattern: '^./b' }] }));
    const { config } = loadConfig(cwd, home);
    const patterns = config.suppress.map((r) => r.commandPattern);

    expect(patterns).toContain('^./a');
    expect(patterns).toContain('^./b');
  });

  test('malformed JSON produces a warning and is ignored', () => {
    writeFileSync(join(home, '.pi', 'agent', 'exit-watchdog.json'), '{ not json');
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.suppress).toEqual(DEFAULT_SUPPRESSIONS);
    expect(warnings.length).toBe(1);
  });

  test('malformed regex in user rule produces a warning and rule is skipped', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'exit-watchdog.json'),
      JSON.stringify({ suppress: [{ commandPattern: '[unclosed' }, { commandPattern: '^ok' }] }),
    );
    const { config, warnings } = loadConfig(cwd, home);

    expect(warnings.length).toBe(1);
    expect(config.suppress.some((r) => r.commandPattern === '^ok')).toBe(true);
    expect(config.suppress.some((r) => r.commandPattern === '[unclosed')).toBe(false);
  });

  test('non-array `suppress` is rejected with a warning', () => {
    writeFileSync(join(home, '.pi', 'agent', 'exit-watchdog.json'), JSON.stringify({ suppress: {} }));
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.suppress).toEqual(DEFAULT_SUPPRESSIONS);
    expect(warnings[0]?.error).toContain('array');
  });

  test('entries with non-string commandPattern are silently skipped (lenient)', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'exit-watchdog.json'),
      JSON.stringify({ suppress: [{ commandPattern: 42 }, { commandPattern: '^real' }] }),
    );
    const { config, warnings } = loadConfig(cwd, home);

    // No warning (strict would be noisy for trivial malformed entries); just drop it.
    expect(warnings).toEqual([]);
    expect(config.suppress.some((r) => r.commandPattern === '^real')).toBe(true);
  });

  test('JSONC comments are supported', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'exit-watchdog.json'),
      `// comment\n{ "suppress": [{ "commandPattern": "^ok" }] }`,
    );
    const { config, warnings } = loadConfig(cwd, home);

    expect(warnings).toEqual([]);
    expect(config.suppress.some((r) => r.commandPattern === '^ok')).toBe(true);
  });
});
