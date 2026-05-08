/**
 * Auto-detect pre-commit hook configurations and synthesize
 * `commandSatisfies` rules the `verify-before-claim` extension can use
 * to credit a successful `git commit` with whichever verifications the
 * project's pre-commit hook actually runs.
 *
 * Scope:
 *
 *   - Reads only DECLARATIVE config: shell-script text, JSON /
 *     JSONC, and property lookups inside `package.json`. We NEVER
 *     evaluate user JS/TS config (`lint-staged.config.mjs`, etc.) —
 *     that would require running user code at session-start, which is
 *     a security and portability landmine. Instead we text-scan the
 *     file for known tool tokens. That handles the common shape
 *     (literal commands in the config) and gracefully degrades for
 *     fancy dynamic configs (we just fall back to the explicit
 *     `commandSatisfies` config file).
 *
 *   - Supports: `.husky/pre-commit` (Husky v7+), `package.json` ->
 *     `husky.hooks.pre-commit` (Husky v4 legacy), `lint-staged.config.*`
 *     (any extension — text-scanned), `.lintstagedrc` /
 *     `.lintstagedrc.json` (JSONC), `package.json` -> `lint-staged`
 *     (inline config).
 *
 *   - Does NOT support: `.pre-commit-config.yaml` (pre-commit.com)
 *     in this MVP — no YAML parser in the repo today. If a project
 *     uses it, users can add explicit `commandSatisfies` rules via
 *     `verify-before-claim.json` as a fallback.
 *
 *   - Does NOT recurse into sub-scripts: if `.husky/pre-commit`
 *     invokes `./scripts/ci.sh`, we stop at the husky file. Following
 *     one level of indirection is doable but can mask a false
 *     positive (the shim runs one subset for PRs and another for
 *     pushes); the cost of missing a verifier ("nag on a valid
 *     claim") is better than crediting one that didn't run.
 *
 * Mapping philosophy:
 *
 *   For each known tool token we observe in a hook config, add the
 *   claim-kinds that tool would plausibly satisfy. Err LIBERAL on the
 *   match (find the tool once anywhere in the file → count it) —
 *   false positives suppress a legitimate nudge (annoying but safe),
 *   false negatives cry wolf on a real claim (worse UX). Same
 *   asymmetry as `verify-detect.ts`'s command matchers.
 *
 * Output:
 *
 *   If ANY claim kinds are inferred, we return a SINGLE synthesized
 *   `CompiledSatisfyRule` whose pattern matches `git commit` (but NOT
 *   `git commit --no-verify` / `-n`) and whose `kinds` are the union
 *   of everything we detected. The `source` string carries a
 *   breadcrumb so warnings / debug tools can tell where it came from.
 *
 *   If no kinds are inferred (no hook config, or hook config uses
 *   tools we don't recognise), we return `{ rules: [], ... }` — same
 *   shape as `loadSatisfyRules` so the extension can concat both
 *   lists blindly.
 *
 * Warnings:
 *
 *   Parse failures on the JSON files produce structured warnings
 *   (mirrors `loadSatisfyRules`'s `ConfigWarning[]` shape). Missing
 *   files are silent — not every project has a pre-commit hook.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonc } from './jsonc.ts';
import { type ClaimKind, type CompiledSatisfyRule, type ConfigWarning } from './verify-detect.ts';

// ──────────────────────────────────────────────────────────────────────
// Tool-name → claim-kind mapping
//
// Keep in rough sync with `COMMAND_PATTERNS` in `verify-detect.ts`, but
// note the shapes differ: there we match EXECUTED bash commands with
// shell-aware anchors; here we match TOKENS in a config-file blob. A
// plain word boundary is enough because the surrounding text is
// declarative ("oxfmt --no-error-on-unmatched-pattern"), not a live
// shell pipeline.
// ──────────────────────────────────────────────────────────────────────

interface ToolPattern {
  /** Human-readable tool name surfaced in the `info.tools` array. */
  readonly name: string;
  /** Token that identifies the tool in the hook config text. */
  readonly token: RegExp;
  /** Claim kinds a successful run of this tool would satisfy. */
  readonly kinds: readonly ClaimKind[];
}

// Order roughly "most-specific first" so `ruff format` wins over `ruff`.
// Matching is not short-circuited — every pattern is tested — but the
// `info.tools` list reflects the encountered order.
const TOOL_PATTERNS: readonly ToolPattern[] = [
  // Formatters
  { name: 'prettier', token: /\bprettier\b/i, kinds: ['format-clean'] },
  { name: 'oxfmt', token: /\boxfmt\b/i, kinds: ['format-clean'] },
  { name: 'gofmt', token: /\bgofmt\b/i, kinds: ['format-clean'] },
  { name: 'rustfmt', token: /\brustfmt\b/i, kinds: ['format-clean'] },
  { name: 'cargo fmt', token: /\bcargo\s+fmt\b/i, kinds: ['format-clean'] },
  { name: 'black', token: /\bblack\b/i, kinds: ['format-clean'] },
  { name: 'ruff format', token: /\bruff\s+format\b/i, kinds: ['format-clean'] },
  { name: 'biome format', token: /\bbiome\s+format\b/i, kinds: ['format-clean'] },

  // Linters
  { name: 'eslint', token: /\beslint\b/i, kinds: ['lint-clean'] },
  { name: 'oxlint', token: /\boxlint\b/i, kinds: ['lint-clean'] },
  { name: 'shellcheck', token: /\bshellcheck\b/i, kinds: ['lint-clean'] },
  // shfmt both formats AND lints shell — credit both.
  { name: 'shfmt', token: /\bshfmt\b/i, kinds: ['format-clean', 'lint-clean'] },
  { name: 'ruff', token: /\bruff\b/i, kinds: ['lint-clean'] },
  { name: 'pylint', token: /\bpylint\b/i, kinds: ['lint-clean'] },
  { name: 'flake8', token: /\bflake8\b/i, kinds: ['lint-clean'] },
  { name: 'rubocop', token: /\brubocop\b/i, kinds: ['lint-clean'] },
  { name: 'cargo clippy', token: /\bcargo\s+clippy\b/i, kinds: ['lint-clean'] },
  { name: 'golangci-lint', token: /\bgolangci-lint\b/i, kinds: ['lint-clean'] },
  { name: 'markdownlint', token: /\bmarkdownlint(?:-cli2?)?\b/i, kinds: ['lint-clean'] },
  { name: 'biome lint', token: /\bbiome\s+(?:lint|check)\b/i, kinds: ['lint-clean', 'format-clean'] },

  // Type-checkers
  { name: 'tsc', token: /\btsc\b/i, kinds: ['types-check'] },
  { name: 'tsgo', token: /\btsgo\b/i, kinds: ['types-check'] },
  { name: 'mypy', token: /\bmypy\b/i, kinds: ['types-check'] },
  { name: 'pyright', token: /\bpyright\b/i, kinds: ['types-check'] },
  { name: 'pyre', token: /\bpyre\b/i, kinds: ['types-check'] },
  { name: 'flow', token: /\bflow\s+(?:check|status)\b/i, kinds: ['types-check'] },

  // Test runners
  { name: 'vitest', token: /\bvitest\b/i, kinds: ['tests-pass'] },
  { name: 'jest', token: /\bjest\b/i, kinds: ['tests-pass'] },
  { name: 'mocha', token: /\bmocha\b/i, kinds: ['tests-pass'] },
  { name: 'pytest', token: /\bpytest\b/i, kinds: ['tests-pass'] },
  { name: 'cargo test', token: /\bcargo\s+(?:test|nextest)\b/i, kinds: ['tests-pass'] },
  { name: 'go test', token: /\bgo\s+test\b/i, kinds: ['tests-pass'] },
  { name: 'rspec', token: /\brspec\b/i, kinds: ['tests-pass'] },
  { name: 'bats', token: /\bbats\b/i, kinds: ['tests-pass'] },

  // Local wrapper scripts (common across this repo and lots of others).
  // These are intentionally broad — matching `./dev/lint.sh` or a bare
  // `lint.sh` mention counts as both lint AND format because local
  // wrappers conventionally bundle both.
  {
    name: 'dev/lint.sh',
    token: /(?:^|[\s"'`])(?:\.\/)?(?:dev|bin|script|scripts)\/lint\.sh\b/,
    kinds: ['lint-clean', 'format-clean'],
  },
];

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/** Diagnostic info about what the detector actually found. */
export interface DetectedHookInfo {
  /** Files we consulted (missing files are not included here). */
  readonly sources: readonly string[];
  /** Tool names found across all consulted files, deduplicated. */
  readonly tools: readonly string[];
  /** Claim kinds inferred, deduplicated. */
  readonly kinds: readonly ClaimKind[];
}

export interface DetectHookRulesResult {
  readonly rules: readonly CompiledSatisfyRule[];
  readonly warnings: readonly ConfigWarning[];
  readonly info: DetectedHookInfo;
}

// ───────────────────────────────────────────────────────────────────
// Internals (declared above `detectHookRules` so it can call them
// without tripping ESLint's `no-use-before-define`).
// ───────────────────────────────────────────────────────────────────

/**
 * Candidate filenames for lint-staged configs that we TEXT-SCAN rather
 * than parse (JS / TS / MJS / CJS). We never `import()` these — see
 * module header. Order here is immaterial: we scan every one that
 * exists, and the tool-token set is merged regardless.
 */
const LINT_STAGED_CODE_CANDIDATES: readonly string[] = [
  'lint-staged.config.mjs',
  'lint-staged.config.cjs',
  'lint-staged.config.js',
  'lint-staged.config.ts',
  '.lintstagedrc.mjs',
  '.lintstagedrc.cjs',
  '.lintstagedrc.js',
];

/**
 * Candidate filenames for lint-staged configs that are plain JSON /
 * JSONC. The `.lintstagedrc` file (no extension) is JSON by
 * convention; we'll accept JSONC for forgiveness.
 */
const LINT_STAGED_JSON_CANDIDATES: readonly string[] = ['.lintstagedrc', '.lintstagedrc.json', '.lintstagedrc.jsonc'];

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function tryParseJsonc(raw: string, path: string, warnings: ConfigWarning[]): unknown {
  try {
    return parseJsonc(raw);
  } catch (e) {
    warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/**
 * Walk a parsed lint-staged config (shape: `{ glob: string |
 * string[] | …function serialised to string }`) and feed each
 * literal command string to `scanText`.
 *
 * We accept:
 *   - Strings ("oxfmt --no-error-on-unmatched-pattern")
 *   - Arrays of strings (lint-staged's canonical shape)
 *
 * We ignore anything that isn't one of those (functions in JS
 * configs are handled by the code-candidate text-scan path; other
 * shapes shouldn't appear in valid lint-staged config).
 */
function scanParsedLintStaged(config: unknown, source: string, scan: (text: string, src: string) => void): void {
  if (!config || typeof config !== 'object') return;
  for (const [glob, value] of Object.entries(config as Record<string, unknown>)) {
    if (typeof value === 'string') {
      scan(value, `${source}:${glob}`);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') scan(v, `${source}:${glob}`);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────

/**
 * Discover `cwd`'s pre-commit hook configuration and synthesize a
 * `commandSatisfies` rule covering a successful `git commit`.
 *
 * Safe to call repeatedly — it's pure I/O + text parsing, no caching.
 * The extension calls this once per `session_start` alongside
 * `loadSatisfyRules(cwd)`.
 */
export function detectHookRules(cwd: string): DetectHookRulesResult {
  const sources: string[] = [];
  const warnings: ConfigWarning[] = [];
  const tools = new Set<string>();
  const kinds = new Set<ClaimKind>();

  const scanText = (text: string, source: string): void => {
    let hadMatch = false;
    for (const { name, token, kinds: toolKinds } of TOOL_PATTERNS) {
      if (!token.test(text)) continue;
      hadMatch = true;
      tools.add(name);
      for (const k of toolKinds) kinds.add(k);
    }
    if (hadMatch) sources.push(source);
  };

  // ── 1. Husky v7+ shell hook ───────────────────────────────────────
  const huskyPath = join(cwd, '.husky', 'pre-commit');
  const huskyText = tryReadFile(huskyPath);
  if (huskyText !== null) {
    scanText(huskyText, huskyPath);
    // If the husky script calls lint-staged, the real tool list lives
    // in the lint-staged config — which we'll scan below regardless,
    // so no extra plumbing needed here. We only need to record that
    // the hook exists; the text-scan above handles any direct tool
    // invocations (`./dev/lint.sh`, inline `eslint`, etc.).
  }

  // ── 2. lint-staged configs (code + JSON) ──────────────────────────
  // Code-shaped configs: read as text, scan for tool tokens. We never
  // evaluate them — see module header.
  for (const name of LINT_STAGED_CODE_CANDIDATES) {
    const p = join(cwd, name);
    const text = tryReadFile(p);
    if (text !== null) scanText(text, p);
  }

  // JSONC-shaped configs: parse, walk the glob→commands map, scan
  // each command string. Parse errors become warnings rather than
  // crashes.
  for (const name of LINT_STAGED_JSON_CANDIDATES) {
    const p = join(cwd, name);
    const text = tryReadFile(p);
    if (text === null) continue;
    const parsed = tryParseJsonc(text, p, warnings);
    if (parsed === undefined) continue;
    scanParsedLintStaged(parsed, p, scanText);
  }

  // ── 3. package.json inline configs (lint-staged + husky v4) ───────
  const pkgPath = join(cwd, 'package.json');
  const pkgText = tryReadFile(pkgPath);
  if (pkgText !== null) {
    const pkg = tryParseJsonc(pkgText, pkgPath, warnings);
    if (pkg && typeof pkg === 'object') {
      const pkgObj = pkg as Record<string, unknown>;
      const lintStaged = pkgObj['lint-staged'];
      if (lintStaged !== undefined) {
        scanParsedLintStaged(lintStaged, `${pkgPath}#lint-staged`, scanText);
      }
      // Husky v4 legacy: husky.hooks['pre-commit'] is a shell string.
      const husky = pkgObj.husky as { hooks?: Record<string, unknown> } | undefined;
      const v4Hook = husky?.hooks?.['pre-commit'];
      if (typeof v4Hook === 'string') {
        scanText(v4Hook, `${pkgPath}#husky.hooks.pre-commit`);
      }
    }
  }

  if (kinds.size === 0) {
    return {
      rules: [],
      warnings,
      info: { sources, tools: [...tools], kinds: [] },
    };
  }

  // Negative lookahead excludes `--no-verify` and `-n` so commits that
  // skip hooks don't falsely credit verifications that never ran.
  // Character class on the post-token anchor keeps `git commitish`
  // (or similar hypothetical typo) from matching.
  const pattern = /^git\s+commit\b(?!.*(?:--no-verify|\s-n\b))/;
  const rule: CompiledSatisfyRule = {
    re: pattern,
    kinds: new Set(kinds),
    source: `<auto-detected pre-commit: ${sources.join(', ') || '(no sources)'}>`,
  };

  return {
    rules: [rule],
    warnings,
    info: { sources, tools: [...tools], kinds: [...kinds] },
  };
}
