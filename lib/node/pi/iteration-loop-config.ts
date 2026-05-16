/**
 * Config loader for the iteration-loop extension.
 *
 * Loads optional JSONC config from, in precedence order (later
 * overrides earlier):
 *
 *   1. `~/.pi/agent/iteration-loop.json`   (global)
 *   2. `<cwd>/.pi/iteration-loop.json`     (per-project)
 *
 * Each file is optional; missing files are silent. Malformed JSON,
 * bad regex patterns, and unknown keys produce structured warnings
 * that the extension surfaces via `ctx.ui.notify` (same pattern as
 * `verify-detect.ts`'s `loadSatisfyRules`).
 *
 * Supported keys (all optional):
 *
 *   claim_regexes                  string[]  - replace built-in
 *                                              artifact-correctness
 *                                              claim patterns.
 *   claim_regexes_extra            string[]  - APPEND to built-ins
 *                                              instead of replacing.
 *   strict_nudge_after_n_edits     integer   - default 2.
 *   max_iter_default               integer   - forwarded to the
 *                                              `declare` action when
 *                                              the model omits
 *                                              maxIter.
 *   cost_cap_default_usd           number    - same, for maxCostUsd.
 *   archive_on_close               boolean   - default true.
 *
 * Later files override earlier ones for scalar values.
 * `claim_regexes` (replace) from a later file wins over an earlier
 * `claim_regexes_extra`; `claim_regexes_extra` stacks additively.
 *
 * No pi imports - this module is unit-tested under vitest.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseJsonc } from './jsonc.ts';

/**
 * Built-in claim regexes - artifact-correctness sign-offs the
 * iteration-loop wants to catch. Complement to verify-before-claim's
 * test/lint/build regexes: those fire on "tests pass" etc., these
 * fire on "looks right / matches spec / done".
 *
 * Patterns are intentionally narrow - only match claims that sound
 * like the artifact is DONE, not e.g. "the rendering looks right so
 * far" (which contains hedges the pattern rejects). False positives
 * just add noise; false negatives let genuinely-unverified claims
 * slip through.
 */
export const BUILT_IN_CLAIM_REGEXES: readonly string[] = [
  // "looks right / looks correct / looks good"
  '(?:it|this|that|the (?:artifact|result|output|rendering|image|svg|file|chart|diagram|config))\\s+(?:looks?|seems?|appears?)\\s+(?:right|correct|good|fine|ok|okay)\\b',
  // "matches the spec / rubric / reference"
  '\\bmatch(?:es|ed|ing)?\\s+(?:the\\s+)?(?:spec(?:ification)?|rubric|reference|requirements?|expect(?:ation|ed))\\b',
  // "the artifact is done / correct / ready / finished"
  '\\b(?:artifact|result|output|rendering|image|svg|file|chart|diagram|config)\\s+is\\s+(?:done|correct|ready|finished|complete|good|right)\\b',
  // "rendered correctly / generated correctly"
  '\\b(?:rendered|generated|produced|drawn|built)\\s+(?:it\\s+)?(?:correctly|properly|as\\s+expected|as\\s+specified)\\b',
  // "the SVG / image / output is done"
  '\\bthat\\s+(?:should|ought to)\\s+(?:match|satisfy|cover|be\\s+(?:it|right|correct|enough))\\b',
];

export interface IterationLoopConfig {
  /** Compiled claim regexes - built-ins by default, replaced or
   *  appended to via the JSONC files. */
  claimRegexes: RegExp[];
  /** Number of edits-to-artifact per turn that triggers the strict
   *  nudge. Default 2. */
  strictNudgeAfterNEdits: number;
  /** Default `maxIter` forwarded into `check declare` calls that
   *  omit it. The extension owns whether to actually apply it. */
  maxIterDefault: number | null;
  /** Default `maxCostUsd` likewise. */
  costCapDefaultUsd: number | null;
  /** Whether `check close` archives the task directory. Default true. */
  archiveOnClose: boolean;
}

export interface ConfigWarning {
  path: string;
  error: string;
}

export interface ConfigLoadResult {
  config: IterationLoopConfig;
  warnings: ConfigWarning[];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

// Deep-frozen default config. `Object.freeze` alone leaves nested
// arrays/objects mutable, and a stray caller that mutated
// DEFAULT_CONFIG.claimRegexes could poison the copy every subsequent
// loadIterationLoopConfig call reads from. Nothing does that today,
// but a deep-freeze here is cheap insurance.
const DEFAULT_CONFIG: IterationLoopConfig = deepFreeze({
  claimRegexes: [],
  strictNudgeAfterNEdits: 2,
  maxIterDefault: null,
  costCapDefaultUsd: null,
  archiveOnClose: true,
});

/** Wrap the built-in string regexes into compiled `RegExp` objects.
 *  Exported so callers can build custom compositions without going
 *  through the full loader (tests, fallback paths). */
export function compileBuiltInClaimRegexes(): RegExp[] {
  return BUILT_IN_CLAIM_REGEXES.map((src) => new RegExp(src, 'i'));
}

function compileRegexArray(source: unknown[], path: string, warnings: ConfigWarning[], fieldName: string): RegExp[] {
  const out: RegExp[] = [];
  for (const entry of source) {
    if (typeof entry !== 'string' || entry.length === 0) {
      warnings.push({ path, error: `${fieldName}: entries must be non-empty strings` });
      continue;
    }
    try {
      out.push(new RegExp(entry, 'i'));
    } catch (e) {
      warnings.push({
        path,
        error: `${fieldName}: invalid regex ${JSON.stringify(entry)} (${e instanceof Error ? e.message : String(e)})`,
      });
    }
  }
  return out;
}

/**
 * Load + merge config from global and project JSONC files. Missing
 * files are silent; bad fields are warnings but the loader always
 * returns a usable config.
 *
 * `home` is injected for tests; defaults to `os.homedir()`.
 */
export function loadIterationLoopConfig(cwd: string, home: string = homedir()): ConfigLoadResult {
  const warnings: ConfigWarning[] = [];
  const paths = [join(home, '.pi', 'agent', 'iteration-loop.json'), join(cwd, '.pi', 'iteration-loop.json')];

  // Mutable working copy seeded with defaults; claim regexes start
  // empty and are populated after we know whether a file replaced
  // them explicitly. See `claimReplaced` below.
  const working: IterationLoopConfig = {
    claimRegexes: [],
    strictNudgeAfterNEdits: DEFAULT_CONFIG.strictNudgeAfterNEdits,
    maxIterDefault: DEFAULT_CONFIG.maxIterDefault,
    costCapDefaultUsd: DEFAULT_CONFIG.costCapDefaultUsd,
    archiveOnClose: DEFAULT_CONFIG.archiveOnClose,
  };

  // Track whether any file explicitly REPLACED the built-in claim
  // list. When true, we skip the built-ins entirely in the merge;
  // when false, we prepend them. `claim_regexes_extra` always
  // appends regardless.
  let claimReplaced = false;
  const replaceRegexes: RegExp[] = [];
  const extraRegexes: RegExp[] = [];

  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      warnings.push({ path, error: 'config root must be an object' });
      continue;
    }
    const obj = parsed as Record<string, unknown>;

    // ── claim_regexes (replace) ─────────────────────────────────────
    if (obj.claim_regexes !== undefined) {
      if (!Array.isArray(obj.claim_regexes)) {
        warnings.push({ path, error: '`claim_regexes` must be an array of regex strings' });
      } else {
        const compiled = compileRegexArray(obj.claim_regexes, path, warnings, 'claim_regexes');
        // The file explicitly set `claim_regexes`, so it wants to
        // REPLACE the built-ins regardless of whether any individual
        // entries compiled. Otherwise a file that accidentally lists
        // only invalid regexes would silently fall back to built-ins,
        // which disagrees with the doc ("replace the built-in").
        claimReplaced = true;
        replaceRegexes.length = 0;
        replaceRegexes.push(...compiled);
      }
    }

    // ── claim_regexes_extra (append) ────────────────────────────────
    if (obj.claim_regexes_extra !== undefined) {
      if (!Array.isArray(obj.claim_regexes_extra)) {
        warnings.push({ path, error: '`claim_regexes_extra` must be an array of regex strings' });
      } else {
        const compiled = compileRegexArray(obj.claim_regexes_extra, path, warnings, 'claim_regexes_extra');
        extraRegexes.push(...compiled);
      }
    }

    // ── scalar knobs ─────────────────────────────────────────────────
    if (obj.strict_nudge_after_n_edits !== undefined) {
      const n = obj.strict_nudge_after_n_edits;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        warnings.push({ path, error: '`strict_nudge_after_n_edits` must be an integer ≥ 1' });
      } else {
        working.strictNudgeAfterNEdits = n;
      }
    }
    if (obj.max_iter_default !== undefined) {
      const v = obj.max_iter_default;
      if (v === null) {
        working.maxIterDefault = null;
      } else if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        warnings.push({ path, error: '`max_iter_default` must be an integer ≥ 1 or null' });
      } else {
        working.maxIterDefault = v;
      }
    }
    if (obj.cost_cap_default_usd !== undefined) {
      const v = obj.cost_cap_default_usd;
      if (v === null) {
        working.costCapDefaultUsd = null;
      } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        warnings.push({ path, error: '`cost_cap_default_usd` must be a non-negative number or null' });
      } else {
        working.costCapDefaultUsd = v;
      }
    }
    if (obj.archive_on_close !== undefined) {
      const v = obj.archive_on_close;
      if (typeof v !== 'boolean') {
        warnings.push({ path, error: '`archive_on_close` must be a boolean' });
      } else {
        working.archiveOnClose = v;
      }
    }
  }

  // Final claim-regex list: built-ins (unless replaced) + replace +
  // extras. The replace list is ALSO the user's explicit baseline
  // when they chose to override the built-ins.
  if (claimReplaced) {
    working.claimRegexes = [...replaceRegexes, ...extraRegexes];
  } else {
    working.claimRegexes = [...compileBuiltInClaimRegexes(), ...extraRegexes];
  }

  return { config: working, warnings };
}

/**
 * Does any of the compiled claim regexes match the given text?
 * Small helper kept here (rather than inline in the extension) so
 * the matching rule is easy to assert against in tests.
 */
export function matchesClaimRegex(regexes: readonly RegExp[], text: string): RegExp | null {
  if (!text || regexes.length === 0) return null;
  for (const re of regexes) {
    if (re.test(text)) return re;
  }
  return null;
}
