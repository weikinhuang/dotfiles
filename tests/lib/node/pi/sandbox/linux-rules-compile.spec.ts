/**
 * Tests for lib/node/pi/sandbox/linux-rules-compile.ts.
 *
 * The ripgrep runner is dependency-injected so we replay an arbitrary
 * basename-search oracle without spawning a real rg.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
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

  test('segment rule with hits is collected; inert segments reported', () => {
    const { runner } = stubRg({
      '**/node_modules/**': ['node_modules/foo/index.js'],
      '**/.terraform/**': [],
    });
    const r = compileLinuxRules(rules({ segments: ['node_modules', '.terraform'] }), { cwd, runRipgrep: runner });
    expect(r.paths).toEqual([join(cwd, 'node_modules/foo/index.js')]);
    expect(r.inertSegments).toEqual(['.terraform']);
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

  test('forwards --hidden and --no-ignore-vcs so .gitignore-pruned dirs still get scanned', () => {
    const { runner, calls } = stubRg({ '.env': [] });
    compileLinuxRules(rules({ basenames: ['.env'] }), {
      cwd,
      runRipgrep: runner,
    });
    expect(calls[0]).toContain('--hidden');
    expect(calls[0]).toContain('--no-ignore-vcs');
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
    expect(report.write.paths.sort()).toEqual([join(cwd, 'node_modules/foo/index.js'), join(cwd, 'src/.env')]);
  });
});
