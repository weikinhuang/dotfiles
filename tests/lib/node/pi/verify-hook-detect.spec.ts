/**
 * Tests for lib/node/pi/verify-hook-detect.ts.
 *
 * Pure filesystem-driven detector — we fabricate scratch directory
 * layouts under `tmpdir()` and call `detectHookRules(cwd)` against
 * them. No pi runtime, no network, no process spawning.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type ClaimKind } from '../../../../lib/node/pi/verify-detect.ts';
import { detectHookRules } from '../../../../lib/node/pi/verify-hook-detect.ts';

// ──────────────────────────────────────────────────────────────────────
// Scratch-dir harness
// ──────────────────────────────────────────────────────────────────────

let workdir: string;

beforeEach(() => {
  workdir = join(tmpdir(), `vhd-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workdir, { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Write a file under `workdir` relative to `path`; creates parents as needed. */
const writeFile = (path: string, content: string): void => {
  const abs = join(workdir, path);
  const parent = abs.slice(0, abs.lastIndexOf('/'));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(abs, content);
};

/** Assertion helper: sort for order-independence and reuse the `ClaimKind` type. */
const sortedKinds = (kinds: readonly ClaimKind[]): ClaimKind[] => [...kinds].sort();

// ──────────────────────────────────────────────────────────────────────
// Empty / no-hook cases
// ──────────────────────────────────────────────────────────────────────

test('no hook config at all → no rules, no warnings', () => {
  const { rules, warnings, info } = detectHookRules(workdir);

  expect(rules).toEqual([]);
  expect(warnings).toEqual([]);
  expect(info.tools).toEqual([]);
  expect(info.kinds).toEqual([]);
  expect(info.sources).toEqual([]);
});

test('empty .husky/pre-commit → no rules (nothing to detect)', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nexit 0\n');
  const { rules, info } = detectHookRules(workdir);

  expect(rules).toEqual([]);
  expect(info.tools).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Husky v7+ shell script with direct tool invocations
// ──────────────────────────────────────────────────────────────────────

test('.husky/pre-commit invokes eslint directly → credits lint-clean', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx eslint .\n');
  const { rules, info } = detectHookRules(workdir);

  expect(rules).toHaveLength(1);
  expect([...rules[0].kinds]).toEqual(['lint-clean']);
  expect(info.tools).toContain('eslint');
});

test('.husky/pre-commit with ./dev/lint.sh → credits both lint-clean and format-clean', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\n./dev/lint.sh\n');
  const { rules, info } = detectHookRules(workdir);

  expect(rules).toHaveLength(1);
  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  expect(info.tools).toContain('dev/lint.sh');
});

test('.husky/pre-commit invoking lint-staged records husky path as a source', () => {
  // When husky just calls lint-staged, the husky script has no tool
  // tokens of its own — the tools come from lint-staged config. We
  // shouldn't record the husky path as a source in that case.
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx lint-staged\n');
  const { info } = detectHookRules(workdir);

  expect(info.sources.some((s) => s.endsWith('.husky/pre-commit'))).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// lint-staged code-shaped configs (text-scanned)
// ──────────────────────────────────────────────────────────────────────

test('lint-staged.config.mjs with oxfmt + eslint literal commands → credits lint+format', () => {
  writeFile(
    'lint-staged.config.mjs',
    `const config = {
       '*.{ts,tsx}': ['oxfmt --no-error-on-unmatched-pattern', 'eslint'],
     };
     export default config;`,
  );
  const { rules, info } = detectHookRules(workdir);

  expect(rules).toHaveLength(1);
  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  expect(info.tools).toEqual(expect.arrayContaining(['oxfmt', 'eslint']));
});

test('lint-staged.config.cjs detected alongside .mjs variant', () => {
  // Only one candidate file present — make sure we don't require the
  // .mjs specifically.
  writeFile('lint-staged.config.cjs', "module.exports = { '*.ts': ['prettier --write', 'tsc --noEmit'] };");
  const { info } = detectHookRules(workdir);

  expect(info.tools).toEqual(expect.arrayContaining(['prettier', 'tsc']));
});

test('lint-staged.config.ts with function-returning-array shape → text scan still finds tools', () => {
  writeFile(
    'lint-staged.config.ts',
    `export default {
       '*.rs': (files: string[]) => [
         \`rustfmt \${files.join(' ')}\`,
         \`cargo clippy -- -D warnings\`,
       ],
     };`,
  );
  const { rules, info } = detectHookRules(workdir);

  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  expect(info.tools).toEqual(expect.arrayContaining(['rustfmt', 'cargo clippy']));
});

// ──────────────────────────────────────────────────────────────────────
// lint-staged JSON-shaped configs (parsed)
// ──────────────────────────────────────────────────────────────────────

test('.lintstagedrc (no extension, JSON) with oxfmt → credits format-clean', () => {
  writeFile('.lintstagedrc', JSON.stringify({ '*.ts': ['oxfmt', 'eslint'] }));
  const { rules, info } = detectHookRules(workdir);

  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  // `scanParsedLintStaged` tags sources as `path:glob`, so `includes`
  // rather than `endsWith` (the path ends with `:*.ts` here).
  expect(info.sources.some((s) => s.includes('.lintstagedrc'))).toBe(true);
});

test('.lintstagedrc.json with single-string command value', () => {
  writeFile('.lintstagedrc.json', JSON.stringify({ '*.py': 'ruff check' }));
  const { info } = detectHookRules(workdir);

  expect(info.tools).toContain('ruff');
});

test('.lintstagedrc.jsonc with `//` comments parses cleanly (trailing commas are NOT supported by parseJsonc)', () => {
  writeFile(
    '.lintstagedrc.jsonc',
    `{
       // tests run ruff only on Python files
       "*.py": ["ruff check"]
     }`,
  );
  const { rules, warnings } = detectHookRules(workdir);

  expect(warnings).toEqual([]);
  expect([...rules[0].kinds]).toEqual(['lint-clean']);
});

test('malformed .lintstagedrc.json → warning, no rules from that file', () => {
  writeFile('.lintstagedrc.json', '{"*.ts": ["eslint", ]'); // unclosed object + trailing comma in strict JSON
  const { warnings } = detectHookRules(workdir);

  expect(warnings.length).toBeGreaterThanOrEqual(1);
  expect(warnings[0]?.path.endsWith('.lintstagedrc.json')).toBe(true);
});

// ──────────────────────────────────────────────────────────────────────
// package.json inline configs
// ──────────────────────────────────────────────────────────────────────

test('package.json -> lint-staged inline → detected', () => {
  writeFile(
    'package.json',
    JSON.stringify({
      name: 'example',
      'lint-staged': {
        '*.ts': ['eslint', 'prettier --write'],
      },
    }),
  );
  const { rules, info } = detectHookRules(workdir);

  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  expect(info.tools).toEqual(expect.arrayContaining(['eslint', 'prettier']));
  expect(info.sources.some((s) => s.includes('package.json#lint-staged'))).toBe(true);
});

test('package.json -> husky.hooks.pre-commit (Husky v4 legacy) → detected', () => {
  writeFile(
    'package.json',
    JSON.stringify({
      name: 'example',
      husky: {
        hooks: {
          'pre-commit': 'eslint && mypy',
        },
      },
    }),
  );
  const { rules, info } = detectHookRules(workdir);

  expect(sortedKinds([...rules[0].kinds])).toEqual(['lint-clean', 'types-check']);
  expect(info.tools).toEqual(expect.arrayContaining(['eslint', 'mypy']));
});

test('package.json parse failure → warning, no crash', () => {
  writeFile('package.json', '{ not valid json');
  const { warnings } = detectHookRules(workdir);

  expect(warnings.length).toBeGreaterThanOrEqual(1);
  expect(warnings[0]?.path.endsWith('package.json')).toBe(true);
});

// ──────────────────────────────────────────────────────────────────────
// Combined / merge behaviour
// ──────────────────────────────────────────────────────────────────────

test('husky + lint-staged together → tool sets merge into one rule', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx lint-staged\n');
  writeFile(
    'lint-staged.config.mjs',
    `export default {
       '*.ts': ['oxfmt', 'eslint'],
       '*.md': ['markdownlint-cli2 --fix'],
     };`,
  );

  const { rules, info } = detectHookRules(workdir);

  expect(rules).toHaveLength(1);
  expect(sortedKinds([...rules[0].kinds])).toEqual(['format-clean', 'lint-clean']);
  expect(info.tools).toEqual(expect.arrayContaining(['oxfmt', 'eslint', 'markdownlint']));
});

test('multiple tool kinds across sources → synthesized rule covers all', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\ntsc --noEmit\n');
  writeFile(
    'lint-staged.config.mjs',
    `export default {
       '*.ts': ['eslint'],
       '*.py': ['ruff check', 'pytest'],
     };`,
  );

  const { rules } = detectHookRules(workdir);

  expect(sortedKinds([...rules[0].kinds])).toEqual(['lint-clean', 'tests-pass', 'types-check']);
});

// ──────────────────────────────────────────────────────────────────────
// Synthesized rule pattern
// ──────────────────────────────────────────────────────────────────────

describe('synthesized rule pattern', () => {
  const setupMinimalHook = (): void => {
    writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx eslint .\n');
  };

  test('matches a plain `git commit -m "..."`', () => {
    setupMinimalHook();
    const { rules } = detectHookRules(workdir);
    const re = rules[0].re;

    expect(re.test('git commit -m "add thing"')).toBe(true);
    expect(re.test('git commit -am "quick"')).toBe(true);
    expect(re.test('git commit --amend --no-edit')).toBe(true);
  });

  test('does NOT match `git commit --no-verify`', () => {
    setupMinimalHook();
    const { rules } = detectHookRules(workdir);
    const re = rules[0].re;

    expect(re.test('git commit --no-verify -m "skip"')).toBe(false);
    expect(re.test('git commit -m "foo" --no-verify')).toBe(false);
  });

  test('does NOT match `git commit -n` (short form of --no-verify)', () => {
    setupMinimalHook();
    const { rules } = detectHookRules(workdir);
    const re = rules[0].re;

    expect(re.test('git commit -n -m "skip"')).toBe(false);
  });

  test('does NOT match unrelated git commands', () => {
    setupMinimalHook();
    const { rules } = detectHookRules(workdir);
    const re = rules[0].re;

    expect(re.test('git status')).toBe(false);
    expect(re.test('git log --oneline')).toBe(false);
    expect(re.test('echo "git commit" is blocked')).toBe(false); // doesn't start with `git commit`
  });

  test('source string carries a breadcrumb back to the consulted files', () => {
    setupMinimalHook();
    const { rules } = detectHookRules(workdir);

    expect(rules[0].source).toContain('auto-detected pre-commit');
    expect(rules[0].source).toContain('.husky/pre-commit');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Info contract
// ──────────────────────────────────────────────────────────────────────

test('info.tools is deduplicated across sources', () => {
  // eslint mentioned in BOTH husky and lint-staged — should appear once.
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx eslint .\n');
  writeFile('lint-staged.config.mjs', "export default { '*.ts': ['eslint'] };");

  const { info } = detectHookRules(workdir);
  const eslintCount = info.tools.filter((t) => t === 'eslint').length;

  expect(eslintCount).toBe(1);
});

test('info.kinds is deduplicated across sources', () => {
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nnpx eslint .\n');
  writeFile('lint-staged.config.mjs', "export default { '*.js': ['oxlint'] };");

  const { info } = detectHookRules(workdir);
  const lintCount = info.kinds.filter((k) => k === 'lint-clean').length;

  expect(lintCount).toBe(1);
});

test('info.sources excludes files that existed but matched nothing', () => {
  // Hook file exists but is just `exit 0` — no tool tokens.
  writeFile('.husky/pre-commit', '#!/usr/bin/env sh\nexit 0\n');
  const { info } = detectHookRules(workdir);

  expect(info.sources).toEqual([]);
});
