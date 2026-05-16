/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope
 * because TS function declarations are hoisted and this file
 * reads top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Deep-research structural check - Phase 4 first-stage validator.
 *
 * This module is the deterministic half of the two-stage review
 * loop declared by `config/pi/extensions/deep-research.ts`. It
 * answers the question "does the freshly-synthesized report
 * satisfy the structural contract?" without invoking an LLM, so
 * the subjective critic only ever sees reports that are already
 * structurally sound.
 *
 * The contract is enumerated in
 * `deep-research-rubric.ts::STRUCTURAL_CHECK_ITEMS` and
 * materialized as `rubric-structural.md` in the run root. Every
 * item in that list maps onto one check in this module:
 *
 *   - `report-exists`                  - `report.md` is readable.
 *   - `footnote-markers-resolve`       - every `[^n]` marker in
 *                                         the body has a matching
 *                                         `[^n]: <title> - <url>`
 *                                         entry in the footnotes
 *                                         block.
 *   - `footnote-urls-in-store`         - every footnote URL is
 *                                         present as a
 *                                         `sources/<hash>.json`
 *                                         entry in the run's
 *                                         source store.
 *   - `no-unresolved-placeholders`     - no `{{SRC:<id>}}`
 *                                         placeholders remain
 *                                         anywhere in the report.
 *   - `every-sub-question-has-section` - the report contains at
 *                                         least `plan.subQuestions.length`
 *                                         `## …` headings
 *                                         (Conclusion excluded).
 *   - `no-duplicate-footnote-ids`      - `[^n]:` footnote
 *                                         definitions are unique
 *                                         and densely numbered.
 *   - `no-bare-urls-in-body`           - URLs embedded in the body
 *                                         prose (outside the
 *                                         footnote block) come
 *                                         from the source store;
 *                                         no hallucinated URLs.
 *
 * Two entry points:
 *
 *   1. Pure library ({@link checkReportStructure}) - takes a run
 *      root, returns a `{ ok, failures, stats }` result. This is
 *      what the review-loop orchestrator consumes and what
 *      deep-research-structural-check.spec.ts drives.
 *
 *   2. CLI (the bottom of this file) - invoked as
 *      `node <path>/deep-research-structural-check.ts <runRoot>`
 *      by the `kind=bash` iteration-loop check. Exits 0 on pass,
 *      non-zero on fail, and prints a diagnostic to stderr for
 *      each failure so the bash-check's observation payload is
 *      actionable.
 *
 * No pi imports. Runs against a fixture under vitest and against
 * a real run root as a shell subprocess.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { SRC_PLACEHOLDER_RE } from './research-citations.ts';
import { paths } from './research-paths.ts';
import { readPlan } from './research-plan.ts';
import { listRun, normalizeUrl, type SourceRef } from './research-sources.ts';

// ──────────────────────────────────────────────────────────────────────
// Public types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Stable identifier for a failed check. Matches an id from
 * `STRUCTURAL_CHECK_ITEMS` in `deep-research-rubric.ts` so the
 * extension's refinement path can key nudges off a failure kind
 * without stringy matching. Multiple failures can share an id
 * (e.g. two unknown footnote urls → two `footnote-urls-in-store`
 * entries) so callers can surface the full list.
 */
export type StructuralCheckId =
  | 'report-exists'
  | 'footnote-markers-resolve'
  | 'footnote-urls-in-store'
  | 'no-unresolved-placeholders'
  | 'every-sub-question-has-section'
  | 'no-duplicate-footnote-ids'
  | 'no-bare-urls-in-body'
  | 'every-section-cites-a-source';

/**
 * A single structural failure. `id` identifies the check, `message`
 * is the human-readable diagnostic suitable for stderr or a
 * journal entry, and `location` (optional) is a short pointer into
 * the report (line number, footnote id, URL, etc.).
 */
export interface StructuralFailure {
  id: StructuralCheckId;
  message: string;
  location?: string;
}

/**
 * Stats gathered during the check. Useful for journal entries and
 * for tests that want to assert "we actually parsed N footnotes"
 * beyond just "the check passed".
 */
export interface StructuralStats {
  footnoteMarkers: number;
  footnoteEntries: number;
  sections: number;
  subQuestions: number;
  placeholders: number;
  sourcesInStore: number;
  bareUrlsInBody: number;
}

export interface StructuralCheckResult {
  ok: boolean;
  failures: StructuralFailure[];
  stats: StructuralStats;
}

export interface CheckReportStructureOpts {
  /** Absolute path to the deep-research run root. */
  runRoot: string;
  /**
   * Override for the report path. Defaults to
   * `paths(runRoot).report` (`<runRoot>/report.md`).
   */
  reportPath?: string;
  /**
   * Override for the plan path. Defaults to
   * `paths(runRoot).plan` (`<runRoot>/plan.json`).
   */
  planPath?: string;
  /**
   * Inject a pre-loaded source index to bypass the disk probe.
   * Tests use this to avoid materializing a real
   * `sources/<hash>.json` tree. When unset, we call
   * `research-sources.listRun(runRoot)`.
   */
  sourceIndex?: readonly SourceRef[];
}

// ──────────────────────────────────────────────────────────────────────
// Regexes + shared constants.
// ──────────────────────────────────────────────────────────────────────

/**
 * Match `[^n]` markers in the body. Excludes footnote definition
 * lines, which are detected separately via `FOOTNOTE_ENTRY_RE`.
 * The `(?!:)` lookahead rejects `[^n]:` (definition) and the
 * `[^n](?!:)` variant stops early enough that two consecutive
 * markers like `[^1][^2]` both match on separate iterations.
 */
const FOOTNOTE_MARKER_RE = /\[\^(\d+)\](?!:)/g;

/**
 * Match `[^n]:` footnote definitions. Anchored to start-of-line
 * (via `m` flag) so a stray `[^n]:` inside a paragraph doesn't
 * get parsed as a definition. The body after the colon captures
 * title + url (separator convention is ` - `, per
 * `research-citations.renumber`).
 */
const FOOTNOTE_ENTRY_RE = /^\[\^(\d+)\]:\s*(.+?)\s*$/gm;

/**
 * `{{SRC:<id>}}` placeholder that Phase-3 synth should have
 * renumbered. Canonical pattern imported from
 * `research-citations.ts` (aliased above) - keeping one source of
 * truth prevents a future id-character-class change in one place
 * from silently drifting from the other.
 */
// `SRC_PLACEHOLDER_RE` is re-exported here by importing it above;
// the local declaration used by Phase-4 lives in research-citations.

/**
 * URL matcher used for bare-url detection. Deliberately forgiving
 * - we're looking for anything that looks like an http/https URL
 * in prose. Trailing ASCII punctuation is stripped via
 * {@link trimTrailingPunctuation} before the URL is normalized
 * (otherwise a sentence-ending `.`, `,`, `)` clings to the match
 * and breaks store lookups).
 */
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]{}]+/g;

/**
 * Trailing ASCII punctuation that should never be part of a URL
 * in running prose. `)` is handled separately in
 * {@link trimTrailingPunctuation} with a balanced-parens rule
 * because a URL like `.../Rust_(programming_language)` is legal
 * and the closing paren is load-bearing.
 */
const TRAILING_URL_PUNCTUATION_CHARS = new Set(['.', ',', ';', ':', '!', '?', '"', "'", ']', '}']);

/**
 * Strip trailing sentence-level punctuation from a URL match so
 * `see https://example.com/a.` yields `https://example.com/a`
 * (and not an unparseable / unmatchable variant). A trailing `)`
 * is kept when the URL has at least as many `(` as `)` so
 * Wikipedia-style paths like
 * `https://en.wikipedia.org/wiki/Rust_(programming_language)`
 * survive intact; an orphan `)` (e.g. `(see https://example.com/a)`)
 * is stripped as before. Pure string op.
 */
function trimTrailingPunctuation(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s[s.length - 1] ?? '';
    if (last === ')') {
      // Peel the trailing `)` only if it is not balanced by an
      // earlier `(`. Count on the string WITHOUT the trailing
      // paren so `foo(bar)` stays whole but `foo)` sheds its
      // orphan.
      const stripped = s.slice(0, -1);
      let open = 0;
      let close = 0;
      for (const ch of stripped) {
        if (ch === '(') open += 1;
        else if (ch === ')') close += 1;
      }
      if (close >= open) {
        s = stripped;
        continue;
      }
      break;
    }
    if (TRAILING_URL_PUNCTUATION_CHARS.has(last)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/**
 * Section heading regex: `## …` at start-of-line. We skip
 * `# …` (title), `### …` (sub-sub-heading) and the Conclusion
 * heading at the end of the report.
 */
const SECTION_HEADING_RE = /^## (.+?)\s*$/gm;

/**
 * Heading text we treat as "report metadata" and exclude from the
 * sub-question section count. `Conclusion` matches the synth-
 * merge contract (`composeDraft` emits `## Conclusion`).
 * Footnotes are lines starting with `[^n]:`, not headings, so
 * they drop out naturally.
 */
const NON_SECTION_HEADINGS: ReadonlySet<string> = new Set(['Conclusion']);

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

/**
 * Run the structural check over a deep-research run root. Collects
 * every failure (does not early-exit on the first one) so the
 * refinement path can emit one targeted nudge per class of issue.
 *
 * Missing `report.md` short-circuits to a single
 * `report-exists` failure - every downstream check needs the
 * report to be readable, so continuing would emit misleading
 * diagnostics.
 *
 * Missing / malformed `plan.json` short-circuits similarly - we
 * can't count sub-questions without it.
 */
export function checkReportStructure(opts: CheckReportStructureOpts): StructuralCheckResult {
  const runPaths = paths(opts.runRoot);
  const reportPath = opts.reportPath ?? runPaths.report;
  const planPath = opts.planPath ?? runPaths.plan;

  const failures: StructuralFailure[] = [];
  const stats: StructuralStats = {
    footnoteMarkers: 0,
    footnoteEntries: 0,
    sections: 0,
    subQuestions: 0,
    placeholders: 0,
    sourcesInStore: 0,
    bareUrlsInBody: 0,
  };

  // ── report-exists ─────────────────────────────────────────────
  if (!existsSync(reportPath)) {
    failures.push({
      id: 'report-exists',
      message: `report.md not found at ${reportPath}`,
      location: reportPath,
    });
    return { ok: false, failures, stats };
  }
  let report: string;
  try {
    report = readFileSync(reportPath, 'utf8');
  } catch (err) {
    failures.push({
      id: 'report-exists',
      message: `report.md unreadable: ${(err as Error).message}`,
      location: reportPath,
    });
    return { ok: false, failures, stats };
  }

  // ── plan ─────────────────────────────────────────────────────
  // We allow plan-load failures to surface as a
  // `every-sub-question-has-section` miss - without a plan we
  // can't verify sub-question coverage. The caller (review-loop)
  // is expected to treat a missing plan as a bigger problem than
  // any structural verdict anyway.
  let planSubQuestionCount = 0;
  try {
    const plan = readPlan(planPath);
    if (plan.kind === 'deep-research') {
      planSubQuestionCount = plan.subQuestions.length;
    } else {
      failures.push({
        id: 'every-sub-question-has-section',
        message: `plan.json kind="${plan.kind}" - deep-research structural check expects kind="deep-research"`,
        location: planPath,
      });
    }
  } catch (err) {
    failures.push({
      id: 'every-sub-question-has-section',
      message: `plan.json unreadable: ${(err as Error).message}`,
      location: planPath,
    });
  }
  stats.subQuestions = planSubQuestionCount;

  // ── source index ─────────────────────────────────────────────
  const sourceIndex = opts.sourceIndex ?? listRun(opts.runRoot);
  stats.sourcesInStore = sourceIndex.length;
  const knownUrls = new Set<string>();
  for (const ref of sourceIndex) {
    // Store normalizes before persisting, but users may hand-edit;
    // run every URL through `normalizeUrl` defensively so the
    // lookup key is stable even if an entry drifted.
    try {
      knownUrls.add(normalizeUrl(ref.url));
    } catch {
      // Malformed url in the store - skip it rather than throw;
      // the bare-url check below surfaces a clean fail for any
      // unmatched body URL regardless.
    }
  }

  // ── split body vs footnote block ──────────────────────────────
  const { body, footnotesBlock, footnotes, duplicates } = partitionReport(report);
  stats.footnoteEntries = footnotes.size;

  // ── no-duplicate-footnote-ids ────────────────────────────────
  for (const dup of duplicates) {
    failures.push({
      id: 'no-duplicate-footnote-ids',
      message: `footnote id ^${dup} has multiple definitions in the footnotes block`,
      location: `[^${dup}]:`,
    });
  }
  // Also require dense numbering (`[^1]` … `[^N]`). Missing
  // numbers would surface as marker-resolution failures below,
  // but an out-of-order numbering is worth flagging as a separate
  // diagnostic.
  if (footnotes.size > 0) {
    const nums = Array.from(footnotes.keys()).sort((a, b) => a - b);
    const expected = nums.length;
    const maxN = nums[nums.length - 1];
    if (nums[0] !== 1 || maxN !== expected) {
      failures.push({
        id: 'no-duplicate-footnote-ids',
        message: `footnote numbering is not dense 1..${expected}: saw ${nums.join(', ')}`,
      });
    }
  }

  // ── footnote-markers-resolve ─────────────────────────────────
  const markerIds = new Set<number>();
  for (const m of body.matchAll(FOOTNOTE_MARKER_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    markerIds.add(n);
    stats.footnoteMarkers += 1;
  }
  for (const n of markerIds) {
    if (!footnotes.has(n)) {
      failures.push({
        id: 'footnote-markers-resolve',
        message: `report body references [^${n}] but no matching [^${n}]: entry is present in the footnotes block`,
        location: `[^${n}]`,
      });
    }
  }
  // Also flag footnote entries that no body marker references - a
  // dangling definition is a synth bug worth surfacing so the
  // refinement nudge can trim it.
  for (const [n] of footnotes) {
    if (!markerIds.has(n)) {
      failures.push({
        id: 'footnote-markers-resolve',
        message: `footnotes block defines [^${n}]: but no [^${n}] marker appears in the report body`,
        location: `[^${n}]:`,
      });
    }
  }

  // ── footnote-urls-in-store ───────────────────────────────────
  for (const [n, entry] of footnotes) {
    // Empty URL → the synth didn't emit one; structural fail.
    if (!entry.url) {
      failures.push({
        id: 'footnote-urls-in-store',
        message: `footnote [^${n}]: has no URL (expected "[^${n}]: <title> - <url>")`,
        location: `[^${n}]:`,
      });
      continue;
    }
    const cleaned = trimTrailingPunctuation(entry.url);
    let norm: string;
    try {
      norm = normalizeUrl(cleaned);
    } catch {
      failures.push({
        id: 'footnote-urls-in-store',
        message: `footnote [^${n}]: URL is unparseable: ${entry.url}`,
        location: `[^${n}]:`,
      });
      continue;
    }
    if (!knownUrls.has(norm)) {
      failures.push({
        id: 'footnote-urls-in-store',
        message: `footnote [^${n}]: URL ${entry.url} does not match any sources/*.json entry`,
        location: `[^${n}]:`,
      });
    }
  }

  // ── no-unresolved-placeholders ───────────────────────────────
  const placeholders = report.match(SRC_PLACEHOLDER_RE) ?? [];
  stats.placeholders = placeholders.length;
  for (const ph of placeholders) {
    failures.push({
      id: 'no-unresolved-placeholders',
      message: `unresolved placeholder ${ph} remains in the report - synth should have renumbered it`,
      location: ph,
    });
  }

  // ── every-sub-question-has-section ───────────────────────────
  const headings: string[] = [];
  for (const m of body.matchAll(SECTION_HEADING_RE)) {
    const text = (m[1] ?? '').trim();
    if (text.length === 0) continue;
    if (NON_SECTION_HEADINGS.has(text)) continue;
    headings.push(text);
  }
  stats.sections = headings.length;
  if (planSubQuestionCount > 0 && headings.length < planSubQuestionCount) {
    failures.push({
      id: 'every-sub-question-has-section',
      message:
        `report has ${headings.length} sub-question section${headings.length === 1 ? '' : 's'} ` +
        `but plan.json declares ${planSubQuestionCount} - every sub-question needs a "## …" section or ` +
        `an explicit "[section unavailable: …]" stub`,
    });
  }

  // ── every-section-cites-a-source ──────────────────────────
  // Walk the body section-by-section and require at least one
  // `[^n]` footnote marker inside each non-stubbed sub-question
  // section. Sections rendered as `[section unavailable: …]`
  // stubs (a `deep-research-synth-sections` fallback when synth
  // or fanout produced nothing usable) are exempt because the
  // stub is itself the honest answer. Without this check, a run
  // that lost every citation (fanout failed to fetch, synth
  // emitted prose without `{{SRC:…}}`) would trivially pass
  // structural on "zero markers → zero resolution failures,"
  // which lets the subjective critic loop burn budget arguing
  // over uncited prose.
  const sectionSlices = sliceBodyByH2(body);
  for (const slice of sectionSlices) {
    if (NON_SECTION_HEADINGS.has(slice.heading)) continue;
    if (isUnavailableStub(slice.contents)) continue;
    // Reuse the body-wide marker regex but scope it to the slice.
    const sliceMarkers = slice.contents.match(FOOTNOTE_MARKER_RE);
    if (!sliceMarkers || sliceMarkers.length === 0) {
      failures.push({
        id: 'every-section-cites-a-source',
        message:
          `section "${slice.heading}" has no [^n] footnote marker - every non-stubbed sub-question ` +
          `section must cite at least one source (or be written as "[section unavailable: …]")`,
        location: slice.heading,
      });
    }
  }

  // ── no-bare-urls-in-body ─────────────────────────────────────
  for (const rawMatch of body.match(BARE_URL_RE) ?? []) {
    stats.bareUrlsInBody += 1;
    // Trim trailing punctuation so `https://example.com/a.` (end
    // of a sentence) normalizes / looks up against the same key
    // the source store persisted.
    const rawUrl = trimTrailingPunctuation(rawMatch);
    let norm: string;
    try {
      norm = normalizeUrl(rawUrl);
    } catch {
      failures.push({
        id: 'no-bare-urls-in-body',
        message: `body contains an unparseable URL: ${rawMatch}`,
        location: rawMatch,
      });
      continue;
    }
    if (!knownUrls.has(norm)) {
      failures.push({
        id: 'no-bare-urls-in-body',
        message: `body URL ${rawUrl} is not in the source store - no hallucinated URLs allowed in prose`,
        location: rawUrl,
      });
    }
  }
  // Intentionally: bare URLs that ARE in the store pass silently.
  // The rubric allows them (the report may quote a source URL
  // inline before citing the footnote) - we only fail on URLs
  // that would embarrass the user.
  // Note: footnotesBlock is excluded because it intentionally
  // contains URLs.
  void footnotesBlock;

  return { ok: failures.length === 0, failures, stats };
}

// ──────────────────────────────────────────────────────────────────────
// Internals - report partitioning.
// ──────────────────────────────────────────────────────────────────────

interface FootnoteEntry {
  title: string;
  url: string;
  rawLine: string;
}

interface Partitioned {
  /**
   * The report body - everything up to (but not including) the
   * first footnote-definition line. URL checks, marker checks,
   * and section counting run against this string.
   */
  body: string;
  /**
   * The footnote-definition block. Kept only for diagnostics /
   * tests; checks don't scan it for markers or headings.
   */
  footnotesBlock: string;
  /** Parsed footnote definitions keyed by numeric id. */
  footnotes: Map<number, FootnoteEntry>;
  /** Ids that appeared more than once in the footnotes block. */
  duplicates: Set<number>;
}

/**
 * Split the report into (body, footnotes block) and parse each
 * `[^n]:` definition. We treat the first footnote-definition line
 * as the boundary - everything after it is the footnotes block.
 *
 * Why the first line and not a blank-line-separated heading?
 * Because `research-citations.renumber` emits footnotes without a
 * heading (just `[^1]: <title> - <url>` lines), and users may
 * have edited the body to match. Using the first `[^n]:` as the
 * boundary avoids depending on a specific separator.
 */
function partitionReport(report: string): Partitioned {
  const lines = report.split(/\r?\n/);
  // Locate the first line that begins with `[^n]:` (a footnote
  // definition). Walk from the top because footnote entries in
  // the middle of prose would false-partition the body.
  let boundary = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\[\^\d+\]:/.test(lines[i])) {
      boundary = i;
      break;
    }
  }
  const body = lines.slice(0, boundary).join('\n');
  const footnotesBlock = lines.slice(boundary).join('\n');

  const footnotes = new Map<number, FootnoteEntry>();
  const duplicates = new Set<number>();
  // Parse each definition independently. `FOOTNOTE_ENTRY_RE` is
  // anchored by `^` with the `m` flag.
  for (const m of footnotesBlock.matchAll(FOOTNOTE_ENTRY_RE)) {
    const raw = m[1];
    const rest = (m[2] ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    const { title, url } = splitTitleUrl(rest);
    if (footnotes.has(n)) {
      duplicates.add(n);
      // Keep the first entry we saw - duplicates are already
      // surfaced separately via `no-duplicate-footnote-ids`.
      continue;
    }
    footnotes.set(n, { title, url, rawLine: m[0] ?? '' });
  }
  return { body, footnotesBlock, footnotes, duplicates };
}

/**
 * Split a footnote definition body into `(title, url)`. The
 * canonical separator emitted by `research-citations.renumber` is
 * ` - ` (em-dash with spaces). We fall back to "trailing URL" -
 * i.e. if the line contains an http(s) URL, take the last one as
 * the URL and treat the preceding text as the title. This
 * tolerates user-edited footnotes that use a hyphen separator or
 * omit one entirely.
 */
function splitTitleUrl(raw: string): { title: string; url: string } {
  // Canonical separator first - em-dash with spaces.
  const em = raw.lastIndexOf(' - ');
  if (em >= 0) {
    return {
      title: raw.slice(0, em).trim(),
      url: raw.slice(em + ' - '.length).trim(),
    };
  }
  // Trailing URL fallback.
  const urls = raw.match(BARE_URL_RE);
  if (urls && urls.length > 0) {
    const url = urls[urls.length - 1];
    const idx = raw.lastIndexOf(url);
    return {
      title: raw
        .slice(0, idx)
        .replace(/[-\-:\s]+$/, '')
        .trim(),
      url,
    };
  }
  return { title: raw, url: '' };
}

interface BodySlice {
  /** H2 heading text, trimmed, no leading `## ` prefix. */
  heading: string;
  /** The body between this heading and the next H2 (or EOF). */
  contents: string;
}

/**
 * Split a report body into per-`## ` slices. Content before the
 * first H2 (title + abstract + intro) is dropped - those parts
 * carry no per-sub-question citation contract. Pure string op.
 */
function sliceBodyByH2(body: string): BodySlice[] {
  const lines = body.split(/\r?\n/);
  const slices: BodySlice[] = [];
  let current: BodySlice | null = null;
  for (const line of lines) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      if (current) slices.push(current);
      current = { heading: (m[1] ?? '').trim(), contents: '' };
      continue;
    }
    if (current) {
      current.contents += (current.contents ? '\n' : '') + line;
    }
  }
  if (current) slices.push(current);
  return slices;
}

/**
 * True when a section's body is a whole-section
 * `[section unavailable: …]` stub emitted by
 * `deep-research-synth-sections`. Sections that merely mention
 * the phrase in passing still owe the reader a citation, so the
 * regex requires the stub to be the entire trimmed body.
 *
 * Exported for {@link ../research-resume.findStubbedSections},
 * which uses it to surface an "N sub-question sections are
 * stubbed - resume from fanout to re-fetch" hint at review-phase
 * exit.
 */
export function isUnavailableStub(contents: string): boolean {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return false;
  return /^\[section unavailable:[^\]]*\]\s*$/.test(trimmed);
}

// ──────────────────────────────────────────────────────────────────────
// Diagnostic formatting.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render a {@link StructuralCheckResult} into a human-readable
 * block suitable for stderr / journal / refinement nudge. One
 * line per failure, grouped by id so the caller can key off
 * prefixes.
 */
export function formatFailures(result: StructuralCheckResult): string {
  if (result.ok) return '';
  const lines: string[] = [];
  for (const f of result.failures) {
    const loc = f.location ? ` [${f.location}]` : '';
    lines.push(`[${f.id}] ${f.message}${loc}`);
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// CLI entry.
// ──────────────────────────────────────────────────────────────────────

/**
 * Usage string printed on `-h` / `--help` and on malformed
 * invocations. Kept short so the bash check's observation payload
 * doesn't drown diagnostic output.
 */
const USAGE = `Usage: node deep-research-structural-check.ts <runRoot>

Runs the deterministic structural review over <runRoot>. Exits
0 on pass, 1 on failure (with diagnostics on stderr), 2 on
invocation error.`;

/**
 * Entry point for the `kind=bash` iteration-loop check. Not
 * exported as a regular function because callers inside the pipeline
 * should use {@link checkReportStructure} directly - the CLI is
 * only for the bash-check subshell.
 */
function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return args.length === 0 ? 2 : 0;
  }
  if (args.length > 1) {
    process.stderr.write(`too many arguments: ${args.slice(1).join(' ')}\n`);
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  const runRoot = args[0];
  let result: StructuralCheckResult;
  try {
    result = checkReportStructure({ runRoot });
  } catch (err) {
    process.stderr.write(`structural-check: unexpected error: ${(err as Error).message}\n`);
    return 2;
  }

  if (result.ok) {
    // Emit a one-line "ok" summary on stdout so a human running
    // the script manually sees a confirmation. The bash check's
    // `exit-zero` predicate ignores stdout content.
    process.stdout.write(
      `ok - ${result.stats.sections} section(s), ${result.stats.footnoteMarkers} marker(s), ` +
        `${result.stats.footnoteEntries} footnote entr${result.stats.footnoteEntries === 1 ? 'y' : 'ies'}, ` +
        `${result.stats.sourcesInStore} source(s) in store\n`,
    );
    return 0;
  }

  process.stderr.write(formatFailures(result) + '\n');
  process.stderr.write(`structural-check: ${result.failures.length} failure(s)\n`);
  return 1;
}

/**
 * Only run the CLI when this module is the entry point.
 * `process.argv[1]` is the script path passed to node; we compare
 * using `pathToFileURL` so Windows drive letters, paths
 * containing spaces, and special characters round-trip correctly
 * (the naive ``new URL(`file://${path}`)`` shortcut misparses
 * both).
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const code = main(process.argv);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`structural-check: fatal: ${(err as Error).message}\n`);
    process.exit(2);
  }
}
