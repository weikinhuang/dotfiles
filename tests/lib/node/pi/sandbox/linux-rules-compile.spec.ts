/**
 * Tests for lib/node/pi/sandbox/linux-rules-compile.ts.
 *
 * The ripgrep runner is dependency-injected so we replay an arbitrary
 * basename-search oracle without spawning a real rg.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  collapseToSegmentDir,
  compileLinuxPolicy,
  compileLinuxRules,
  type RipgrepRunner,
} from '../../../../../lib/node/pi/sandbox/linux-rules-compile.ts';
import { type FilesystemPolicy, type FilesystemRules } from '../../../../../lib/node/pi/filesystem-policy/schema.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-lrc-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const rules = (over: Partial<FilesystemRules> = {}): FilesystemRules => ({
  basenames: [],
  segments: [],
  paths: [],
  ...over,
});

/** Stub `rg` that records calls and returns a per-glob fixture. */
function stubRg(table: Record<string, string[]>): { runner: RipgrepRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RipgrepRunner = (args, runCwd) => {
    calls.push(args);
    const globIdx = args.indexOf('--glob');
    if (globIdx === -1) return '';
    const glob = args[globIdx + 1];
    const matches = table[glob] ?? [];
    // Tests pass relative paths in `table`; resolve under runCwd to
    // mimic how rg emits them.
    return matches.map((m) => join(runCwd, m)).join('\0') + (matches.length ? '\0' : '');
  };
  return { runner, calls };
}

describe('compileLinuxRules', () => {
  test('basename rule with no on-disk hits is reported as inert', () => {
    const { runner } = stubRg({});
    const r = compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      runRipgrep: runner,
    });
    expect(r.paths).toEqual([]);
    expect(r.inertBasenames).toEqual(['.env']);
  });

  test('basename hits are absolutized + deduped', () => {
    const { runner } = stubRg({
      '.env': ['src/.env', 'src/.env'],
    });
    const r = compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      runRipgrep: runner,
    });
    expect(r.paths).toEqual([join(cwd, 'src/.env')]);
    expect(r.inertBasenames).toEqual([]);
  });

  test('segment rule hits collapse to the segment dir, not per-file', () => {
    const { runner } = stubRg({
      // Per-file rg matches are collapsed to the outermost segment
      // ancestor; bwrap's deny mount is recursive so this is both
      // sufficient and necessary - emitting per-file paths blew the
      // wrap past Linux MAX_ARG_STRLEN in node_modules-heavy repos.
      '**/node_modules/**': ['node_modules/foo/index.js', 'node_modules/foo/pkg/sub.js', 'sub/node_modules/baz/x.ts'],
      '**/.terraform/**': [],
    });
    const r = compileLinuxRules(rules({ segments: ['node_modules', '.terraform'] }), { cwd, runRipgrep: runner });
    expect(r.paths.sort()).toEqual([join(cwd, 'node_modules'), join(cwd, 'sub/node_modules')]);
    expect(r.inertSegments).toEqual(['.terraform']);
  });

  test('multi-segment rule (`.git/hooks`) collapses to the multi-segment dir', () => {
    const { runner } = stubRg({
      '**/.git/hooks/**': ['.git/hooks/pre-commit.sample', '.git/hooks/post-update.sample'],
    });
    const r = compileLinuxRules(rules({ segments: ['.git/hooks'] }), { cwd, runRipgrep: runner });
    expect(r.paths).toEqual([join(cwd, '.git/hooks')]);
  });

  test('nested same-name segment occurrences collapse to the OUTERMOST one', () => {
    // `node_modules/p/node_modules/inner` is covered for free by the
    // outer `node_modules` mount - emitting the inner path would just
    // double up bwrap binds.
    const { runner } = stubRg({
      '**/node_modules/**': ['node_modules/p/node_modules/inner/idx.js'],
    });
    const r = compileLinuxRules(rules({ segments: ['node_modules'] }), { cwd, runRipgrep: runner });
    expect(r.paths).toEqual([join(cwd, 'node_modules')]);
  });

  test('explicit `paths` rules are passed through, missing ones reported inert', () => {
    mkdirSync(join(cwd, 'present'), { recursive: true });
    writeFileSync(join(cwd, 'present', 'file'), 'x');
    const r = compileLinuxRules(
      rules({
        paths: [join(cwd, 'present'), join(cwd, 'absent')],
      }),
      { cwd, runRipgrep: stubRg({}).runner },
    );
    expect(r.paths).toEqual([join(cwd, 'absent'), join(cwd, 'present')].sort());
    expect(r.inertPaths).toEqual([join(cwd, 'absent')]);
  });

  test('extra roots from persona writeRoots are searched too', () => {
    const { runner, calls } = stubRg({
      '.env': [],
    });
    compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      extraRoots: ['/repo/extra'],
      runRipgrep: runner,
    });
    // One call per (rule, root).
    expect(calls.length).toBe(2);
  });

  test('depth is clamped and forwarded to rg --max-depth', () => {
    const { runner, calls } = stubRg({
      '.env': ['src/.env'],
    });
    compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      depth: 99,
      runRipgrep: runner,
    });
    const args = calls[0];
    const idx = args.indexOf('--max-depth');
    expect(args[idx + 1]).toBe('10');
  });

  test('forwards --hidden / --no-ignore / --no-config so user rg config + .gitignore cannot hide deny paths', () => {
    const { runner, calls } = stubRg({ '.env': [] });
    compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      runRipgrep: runner,
    });
    expect(calls[0]).toContain('--hidden');
    expect(calls[0]).toContain('--no-ignore');
    expect(calls[0]).toContain('--no-config');
  });
});

function hasRealRg(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasRealRg())('compileLinuxRules — real ripgrep integration', () => {
  // Guards against regression of the `--null-data` (input flag) vs
  // `--null` / `-0` (output separator) confusion: the stub runner above
  // accepts whatever args we pass, so a wrong flag wouldn't surface there.
  test('basename hits parse correctly when spawning a real rg', () => {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', '.env'), 'X=1');
    writeFileSync(join(cwd, 'src', 'other.txt'), 'unrelated');
    const r = compileLinuxRules(rules({ basenames: ['.env'] }), { cwd });
    expect(r.paths).toEqual([join(cwd, 'src/.env')]);
    expect(r.inertBasenames).toEqual([]);
  });

  test('segment hits parse correctly when spawning a real rg', () => {
    mkdirSync(join(cwd, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'foo', 'index.js'), '//');
    const r = compileLinuxRules(rules({ segments: ['node_modules'] }), { cwd });
    // Per-file rg hits collapse to the segment dir.
    expect(r.paths).toEqual([join(cwd, 'node_modules')]);
    expect(r.inertSegments).toEqual([]);
  });

  test('no on-disk match is reported as inert', () => {
    const r = compileLinuxRules(rules({ basenames: ['.absent'] }), { cwd });
    expect(r.paths).toEqual([]);
    expect(r.inertBasenames).toEqual(['.absent']);
  });
});

describe('compileLinuxPolicy', () => {
  test('compiles read.deny and write.deny independently', () => {
    const policy: FilesystemPolicy = {
      read: {
        deny: { basenames: ['secrets.yml'], segments: [], paths: [] },
        allow: { basenames: [], segments: [], paths: [] },
      },
      write: {
        allow: { basenames: [], segments: [], paths: ['.'] },
        deny: { basenames: ['.env'], segments: ['node_modules'], paths: [] },
      },
    };
    const { runner } = stubRg({
      'secrets.yml': ['conf/secrets.yml'],
      '.env': ['src/.env'],
      '**/node_modules/**': ['node_modules/foo/index.js'],
    });
    const report = compileLinuxPolicy(policy, { cwd, runRipgrep: runner });
    expect(report.read.paths).toEqual([join(cwd, 'conf/secrets.yml')]);
    // segment write.deny matches collapse to the segment dir.
    expect(report.write.paths.sort()).toEqual([join(cwd, 'node_modules'), join(cwd, 'src/.env')]);
  });
});

describe('collapseToSegmentDir', () => {
  test('single-segment file inside a segment dir collapses to the dir', () => {
    expect(collapseToSegmentDir('/repo/node_modules/foo/bar.js', ['node_modules'])).toBe('/repo/node_modules');
  });

  test('multiple sibling occurrences collapse to each occurrence', () => {
    expect(collapseToSegmentDir('/repo/sub/node_modules/baz', ['node_modules'])).toBe('/repo/sub/node_modules');
  });

  test('nested same-name segment collapses to the OUTERMOST occurrence', () => {
    // Outer node_modules covers everything beneath; emitting the inner
    // path would just double up bwrap binds.
    expect(collapseToSegmentDir('/repo/node_modules/p/node_modules/inner', ['node_modules'])).toBe(
      '/repo/node_modules',
    );
  });

  test('multi-segment rule (`.git/hooks`) collapses contiguously', () => {
    expect(collapseToSegmentDir('/repo/.git/hooks/pre-commit.sample', ['.git', 'hooks'])).toBe('/repo/.git/hooks');
  });

  test('multi-segment rule pointing at a file (`.git/config`) collapses to the file path', () => {
    expect(collapseToSegmentDir('/repo/.git/config', ['.git', 'config'])).toBe('/repo/.git/config');
  });

  test('non-matching path returns undefined (defensive against a misconfigured rg runner)', () => {
    expect(collapseToSegmentDir('/repo/src/index.ts', ['node_modules'])).toBeUndefined();
  });

  test('empty segParts returns the path unchanged', () => {
    expect(collapseToSegmentDir('/repo/foo', [])).toBe('/repo/foo');
  });

  test('partial-name match (e.g. `.gitconfig`) does not collapse to a `.git` segment', () => {
    // Component match is exact - segment `.git` does not match `.gitconfig`.
    expect(collapseToSegmentDir('/repo/.gitconfig/foo', ['.git'])).toBeUndefined();
  });

  test('non-contiguous match for multi-segment rule returns undefined', () => {
    // segParts must appear contiguously: `.git` then `hooks`. A path
    // with `.git/foo/hooks` should NOT match `.git/hooks`.
    expect(collapseToSegmentDir('/repo/.git/foo/hooks/x', ['.git', 'hooks'])).toBeUndefined();
  });
});

// Pin the wrap-input size at a small constant across N synthetic
// `compileLinuxPolicy` calls against a stable workspace. Regression
// guard against the E2BIG bug: in a node_modules-heavy repo the
// previous per-file fan-out produced 1100+ paths in `write.deny`,
// which translated to a 245 KiB bwrap argv vs Linux's 128 KiB
// MAX_ARG_STRLEN limit.
describe('wrap-size stability under repeated compilation', () => {
  test('compileLinuxPolicy output stays bounded across 50 calls with a fixed workspace', () => {
    const policy: FilesystemPolicy = {
      read: {
        deny: { basenames: ['.env'], segments: [], paths: [] },
        allow: { basenames: [], segments: [], paths: [] },
      },
      write: {
        allow: { basenames: [], segments: [], paths: ['.'] },
        deny: { basenames: ['.env'], segments: ['node_modules', '.git/hooks'], paths: [] },
      },
    };
    // Stub mimics a Node-heavy workspace: 1500 fake files inside
    // node_modules + 8 hooks. Pre-fix this produced 1500+ paths in the
    // compiled output; post-fix collapse must keep it bounded.
    const nmFiles = Array.from({ length: 1500 }, (_, i) => `node_modules/p${i}/index.js`);
    const hookFiles = [
      '.git/hooks/applypatch-msg.sample',
      '.git/hooks/commit-msg.sample',
      '.git/hooks/post-update.sample',
      '.git/hooks/pre-applypatch.sample',
      '.git/hooks/pre-commit.sample',
      '.git/hooks/pre-merge-commit.sample',
      '.git/hooks/pre-push.sample',
      '.git/hooks/pre-rebase.sample',
    ];
    const { runner } = stubRg({
      '.env': ['src/.env'],
      '**/node_modules/**': nmFiles,
      '**/.git/hooks/**': hookFiles,
    });

    const sizes: number[] = [];
    for (let i = 0; i < 50; i++) {
      const r = compileLinuxPolicy(policy, { cwd, runRipgrep: runner });
      sizes.push(r.write.paths.length);
    }

    // Must collapse to a small constant: <.env file>, <node_modules>,
    // <.git/hooks> = 3 entries. Allow a small slack for future segment
    // additions but FAIL LOUD if anyone reverts the collapse and lets
    // the per-file fan-out come back.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8);
    // Stability: every call against the stable workspace produces the
    // same output size.
    expect(new Set(sizes).size).toBe(1);
  });
});
