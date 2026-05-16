/**
 * Tests for lib/node/pi/iteration-loop-check-bash.ts.
 *
 * Uses real /bin/bash for the exit-code + regex predicate tests -
 * fast enough for CI and exercises the real spawn path. Timeout test
 * uses a short cap against `sleep 10`.
 */

import { describe, expect, test } from 'vitest';

import { runBashCheck } from '../../../../lib/node/pi/iteration-loop-check-bash.ts';

const cwd = process.cwd();

describe('exit-zero predicate', () => {
  test('exit 0 → approved', async () => {
    const r = await runBashCheck({ cmd: 'true' }, { cwd });

    expect(r.approved).toBe(true);
    expect(r.score).toBe(1);
    expect(r.observation.exitCode).toBe(0);
    expect(r.issues).toEqual([]);
  });

  test('exit non-zero → not approved with "exit N" issue', async () => {
    const r = await runBashCheck({ cmd: 'exit 2' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.score).toBe(0);
    expect(r.observation.exitCode).toBe(2);
    expect(r.issues[0].description).toMatch(/exit 2/);
  });

  test('captures stdout and stderr', async () => {
    const r = await runBashCheck({ cmd: 'echo hello; echo oops >&2; exit 1' }, { cwd });

    expect(r.observation.stdout).toContain('hello');
    expect(r.observation.stderr).toContain('oops');
  });
});

describe('regex: predicate', () => {
  test('stdout matches → pass regardless of exit code', async () => {
    const r = await runBashCheck({ cmd: 'echo "status: ok"; exit 1', passOn: 'regex:status: ok' }, { cwd });

    expect(r.approved).toBe(true);
  });

  test('stdout does not match → fail', async () => {
    const r = await runBashCheck({ cmd: 'echo "status: fail"', passOn: 'regex:status: ok' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/did not match/);
  });

  test('invalid regex → fail with diagnostic', async () => {
    const r = await runBashCheck({ cmd: 'echo x', passOn: 'regex:[invalid' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/invalid regex/);
  });
});

describe('output truncation', () => {
  test('large stdout truncated flag set', async () => {
    // 10 KiB of output - exceeds STDOUT_MAX (8 KiB).
    const r = await runBashCheck({ cmd: `printf '%.0sa' {1..10240}` }, { cwd });

    expect(r.observation.stdout.length).toBeLessThanOrEqual(8 * 1024);
    expect(r.observation.truncated).toBe(true);
  });
});

describe('timeout', () => {
  test('SIGTERM fires and result is classified as timed out', async () => {
    const r = await runBashCheck({ cmd: 'sleep 10', timeoutMs: 200 }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.observation.timedOut).toBe(true);
    expect(r.issues[0].description).toMatch(/timed out/);
  }, 5000);
});

describe('env + workdir', () => {
  test('env vars are available to the command', async () => {
    const r = await runBashCheck({ cmd: 'echo $MY_TEST_VAR' }, { cwd, env: { MY_TEST_VAR: 'it-works' } });

    expect(r.observation.stdout).toContain('it-works');
  });

  test('spec env overrides environment env', async () => {
    const r = await runBashCheck(
      { cmd: 'echo $MY_TEST_VAR', env: { MY_TEST_VAR: 'from-spec' } },
      { cwd, env: { MY_TEST_VAR: 'from-env' } },
    );

    expect(r.observation.stdout).toContain('from-spec');
  });
});

describe('unknown passOn', () => {
  test('fails closed with clear diagnostic', async () => {
    const r = await runBashCheck({ cmd: 'true', passOn: 'bogus' as unknown as 'exit-zero' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/unknown passOn/);
  });
});

describe('jq: predicate', () => {
  test('truthy jq expression on stdout → pass', async () => {
    // Regression: earlier versions never dispatched jq and returned a
    // "__jq_pending__"-style meta-failure for every jq: spec.
    const r = await runBashCheck(
      { cmd: `echo '{"status":"ok","count":3}'`, passOn: 'jq:.status == "ok" and .count > 2' },
      { cwd },
    );

    expect(r.approved).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test('falsy jq expression → fail with falsy note', async () => {
    const r = await runBashCheck({ cmd: `echo '{"status":"ok"}'`, passOn: 'jq:.status == "no"' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/falsy|jq/i);
  });

  test('empty jq output (via .missing // empty) → fail', async () => {
    const r = await runBashCheck({ cmd: `echo '{}'`, passOn: 'jq:.missing // empty' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/jq/i);
  });

  test('non-zero jq exit → fail with jq diagnostic', async () => {
    const r = await runBashCheck({ cmd: `echo 'not json'`, passOn: 'jq:.' }, { cwd });

    expect(r.approved).toBe(false);
    expect(r.issues[0].description).toMatch(/jq exited/);
  });

  test('jq runs even when outer command exits non-zero, as long as stdout parses', async () => {
    // jq predicates ignore exit code by design (same as regex:).
    const r = await runBashCheck({ cmd: `echo '{"ok":true}'; exit 1`, passOn: 'jq:.ok' }, { cwd });

    expect(r.approved).toBe(true);
    expect(r.observation.exitCode).toBe(1);
  });
});
