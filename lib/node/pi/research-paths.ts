/**
 * Path + slug helpers for the research-core shared toolkit.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime. Deliberately pure and synchronous - no
 * filesystem access, no subprocess, no clock unless the caller passes
 * `fallbackTimestamp`. That keeps callers free to compose on top
 * without mocking wall-clock time.
 *
 * Conventions:
 *   - A "run" is a single `/research` or `/lab` invocation. Its
 *     on-disk artifacts live under a predictable directory rooted at
 *     `<cwd>/research/<slug>/` (deep-research) or
 *     `<cwd>/research/lab/<slug>/` (autoresearch).
 *   - The slug is derived from the user's question/topic via
 *     `slugify`. When the question is empty or all punctuation, we
 *     fall back to an ISO-timestamp slug so callers always get a
 *     usable non-empty directory name.
 *   - Quarantined artifacts live in a sibling `_quarantined/` dir
 *     next to the artifact's parent, so a bad `findings/f-3.md` ends
 *     up under `findings/_quarantined/`. The sibling layout preserves
 *     "which collection did this come from?" without having to thread
 *     it through every caller.
 */

import { join } from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Slug generation.
// ──────────────────────────────────────────────────────────────────────

/**
 * Maximum characters in a generated slug (before fallback). Chosen to
 * keep directory names readable in `ls` output and well under the
 * common 255-byte filename limit even when composed with timestamps or
 * quarantine suffixes.
 */
export const SLUG_MAX_LENGTH = 40;

export interface SlugifyOpts {
  /**
   * Clock source used when the input has no usable characters. Tests
   * pass a fixed `Date` so fallback slugs are deterministic. Defaults
   * to `new Date()`.
   */
  fallbackTimestamp?: Date;
  /**
   * Override the default max length. Callers normalizing into a tight
   * container (e.g. a 20-char DB key) can shrink; general use should
   * keep the default.
   */
  maxLength?: number;
}

/**
 * Deterministic fallback slug used when `slugify` has no usable input.
 * Format: `r-YYYYMMDD-HHMMSS` in UTC. The `r-` prefix makes it
 * distinguishable from a hand-typed slug at a glance.
 */
function timestampSlug(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());

  return `r-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Turn an arbitrary question/topic string into a kebab-case ASCII
 * slug, ≤ `SLUG_MAX_LENGTH` chars, suitable for use as a directory
 * name on all three supported platforms (Linux, macOS, WSL).
 *
 * Rules:
 *   - Lowercase.
 *   - Strip diacritics via `normalize('NFKD')` + remove combining marks.
 *   - Replace runs of non-`[a-z0-9]` with a single `-`.
 *   - Trim leading/trailing `-`.
 *   - Truncate to `maxLength`, trimming trailing `-` after truncation
 *     so we never end on a dash.
 *   - If the result is empty, return the fallback timestamp slug
 *     `r-<YYYYMMDD>-<HHMMSS>` (UTC, no separators beyond the
 *     surrounding dashes).
 */
export function slugify(input: string, opts: SlugifyOpts = {}): string {
  const max = opts.maxLength ?? SLUG_MAX_LENGTH;
  const normalized = input
    .normalize('NFKD')
    // Strip combining diacritical marks after NFKD decomposition.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized.length === 0) {
    return timestampSlug(opts.fallbackTimestamp ?? new Date());
  }

  if (normalized.length <= max) return normalized;

  // Truncate, then re-trim the trailing dash that truncation may have
  // stranded - `"foo-bar-baz"` cut at 7 chars would otherwise read
  // `"foo-bar"` fine but `"foo--bar"` cut at 5 yields `"foo--"`.
  return normalized.slice(0, max).replace(/-+$/g, '');
}

// ──────────────────────────────────────────────────────────────────────
// Quarantine sibling-directory derivation.
// ──────────────────────────────────────────────────────────────────────

/**
 * Quarantine directory for artifacts that live directly under
 * `parentPath`. Returns `<parentPath>/_quarantined`.
 *
 * We keep the quarantined copy adjacent to the original parent rather
 * than at a top-level `_quarantined/` dir so tooling that walks the
 * run tree (e.g. "list all findings, including failed ones") can
 * recurse into each parent without special-casing a global outcast
 * dir.
 *
 * The name is `_quarantined` (leading underscore) so it sorts before
 * regular children in `ls` output and is trivially excluded by
 * `rg --glob '!_quarantined/'`.
 */
export function quarantineDir(parentPath: string): string {
  return join(parentPath, '_quarantined');
}

// ──────────────────────────────────────────────────────────────────────
// Run directory layout.
// ──────────────────────────────────────────────────────────────────────

/**
 * `<cwd>/research/<slug>/` - root dir for a deep-research run.
 */
export function runRoot(cwd: string, slug: string): string {
  return join(cwd, 'research', slug);
}

/**
 * `<cwd>/research/lab/<slug>/` - root dir for an autoresearch run.
 * The `lab/` subdir keeps experiment runs visually separated from
 * deep-research reports without splitting the top-level `research/`
 * tree.
 */
export function labRoot(cwd: string, slug: string): string {
  return join(cwd, 'research', 'lab', slug);
}

/**
 * Typed bag of known paths derived from a run root. Consumers should
 * reach for these names rather than hand-joining strings so any
 * future layout change is a single-file edit.
 *
 * Directory-typed entries (`sources`, `findings`, `snapshots`,
 * `experiments`) are bare directory paths without a trailing
 * separator - `path.join` does not add one. Callers compose children
 * with `path.join(p.findings, 'f-1.md')` rather than string
 * concatenation.
 */
export interface RunPaths {
  /** `plan.json` - canonical plan state. Consumed by `research-plan`. */
  plan: string;
  /** `journal.md` - append-only markdown journal. */
  journal: string;
  /** `report.md` - final synthesized report (deep-research). */
  report: string;
  /** `rubric-structural.md` - deterministic structural rubric consumed by the Phase-4 `kind=bash` check. */
  rubricStructural: string;
  /** `rubric-subjective.md` - subjective rubric consumed by the Phase-4 `kind=critic` stage. */
  rubricSubjective: string;
  /** `sources/` - per-run source cache directory. */
  sources: string;
  /** `findings/` - per-sub-question finding dir (deep-research). */
  findings: string;
  /** `snapshots/` - iteration-loop artifact snapshots. */
  snapshots: string;
  /** `fanout.json` - live handle file for `research-fanout`. */
  fanout: string;
  /** `experiments/` - per-experiment dir (autoresearch). */
  experiments: string;
  /**
   * Derive the quarantine dir for a specific child path rooted under
   * this run. Delegates to the standalone `quarantineDir` helper so
   * callers outside research-paths (e.g. quarantine logic nested two
   * dirs deep) get the same behavior.
   */
  quarantineRootFor: (parentPath: string) => string;
  /**
   * Canonical provenance-sidecar path for an artifact: `<file>.provenance.json`
   * for non-markdown files. Markdown files carry provenance in a YAML
   * frontmatter block - see `research-provenance.writeSidecar`. The
   * returned sidecar path is still useful for markdown callers that
   * want to migrate content to a sidecar instead.
   */
  provenanceFor: (artifactPath: string) => string;
}

/**
 * Build the typed paths bag from a run root (deep-research or lab).
 * All returned paths are absolute iff `root` is absolute; otherwise
 * they are relative to whatever `root` was relative to (typically the
 * agent cwd).
 */
export function paths(root: string): RunPaths {
  return {
    plan: join(root, 'plan.json'),
    journal: join(root, 'journal.md'),
    report: join(root, 'report.md'),
    rubricStructural: join(root, 'rubric-structural.md'),
    rubricSubjective: join(root, 'rubric-subjective.md'),
    sources: join(root, 'sources'),
    findings: join(root, 'findings'),
    snapshots: join(root, 'snapshots'),
    fanout: join(root, 'fanout.json'),
    experiments: join(root, 'experiments'),
    quarantineRootFor: (parentPath: string) => quarantineDir(parentPath),
    provenanceFor: (artifactPath: string) => `${artifactPath}.provenance.json`,
  };
}
