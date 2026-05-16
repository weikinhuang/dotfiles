/**
 * Canned end-to-end selftest for the research-core toolkit.
 *
 * Both sibling extensions (`pi-deep-research`, `pi-autoresearch`)
 * stitch the same primitives (paths, plan, journal, sources,
 * citations, fanout, watchdog, provenance, ...) into a pipeline.
 * When the toolkit ships or when a dev edits a shared module, the
 * first question is "does the pipeline still wire up end-to-end?"
 * - NOT "does every individual module test pass?".
 *
 * This module is the answer. `selftestDeepResearch` and
 * `selftestAutoresearch` run a deterministic mini-pipeline against
 * a sandbox inside the caller's `cwd`, hand-rolling the writes
 * through the real research-core primitives with a mock
 * `McpClient` and a frozen clock, then byte-for-byte diffs the
 * produced run directory against the committed golden tree under
 * `lib/node/pi/research-selftest/fixtures/<flow>/expected/`.
 *
 * The pipeline deliberately stays tiny: one plan, a handful of
 * journal entries, a couple of fetched sources (deep-research
 * only), one synthesized finding + report. The goal is to
 * exercise the seams between modules (plan <-> paths, sources
 * <-> provenance, citations <-> sources), not to reproduce a
 * full `/research` run.
 *
 * All LLM-style inputs are hardcoded - no `callTyped` is ever
 * invoked, so the selftest runs without a session, without a
 * model, and without the pi runtime. That's what lets the
 * selftest double as a CI smoke test and as a first-run sanity
 * check in `pi --selftest`-style flows.
 *
 * When any module's on-disk output shape changes intentionally,
 * regenerate the fixtures by running the `regenerate*` helpers
 * once (see the module bottom) and commit the updated expected/
 * tree. The tests then rigorously protect that shape from
 * accidental drift.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile } from './atomic-write.ts';
import { renumber, type CitationSource } from './research-citations.ts';
import { appendJournal } from './research-journal.ts';
import { labRoot, paths, runRoot } from './research-paths.ts';
import { writePlan, type AutoresearchPlan, type DeepResearchPlan, type PlanBudget } from './research-plan.ts';
import {
  fetchAndStore,
  type McpClient,
  type McpConvertHtmlResult,
  type McpFetchUrlInput,
  type McpFetchUrlResult,
  type McpSearchWebResult,
} from './research-sources.ts';

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export interface SelftestOpts {
  /**
   * Working directory the selftest builds its run under. Should be
   * a fresh tempdir in tests so the run tree can be blown away
   * without touching the user's real `research/` dir.
   */
  cwd: string;
  /**
   * When true, the pipeline is NOT executed - the function only
   * returns what it would do. Useful for plumbing smoke tests.
   */
  dryRun?: boolean;
}

export type SelftestDiffKind = 'missing' | 'extra' | 'mismatch';

export interface SelftestDiff {
  /** Relative path under the run root (forward-slash separated). */
  path: string;
  kind: SelftestDiffKind;
  /** Present when `kind === 'missing'` or `'mismatch'`. */
  expected?: string;
  /** Present when `kind === 'extra'` or `'mismatch'`. */
  actual?: string;
}

export interface SelftestResult {
  ok: boolean;
  /** Absolute path of the run root the selftest wrote to. */
  runRoot: string;
  /** Empty when `ok` - populated otherwise, one entry per file. */
  diffs: SelftestDiff[];
}

// ──────────────────────────────────────────────────────────────────────
// Hardcoded fixture inputs - single source of truth.
// ──────────────────────────────────────────────────────────────────────

const BUDGET: PlanBudget = {
  maxSubagents: 2,
  maxFetches: 4,
  maxCostUsd: 1,
  wallClockSec: 300,
};

/** Deep-research fixture. Two sources, one sub-question, one report. */
const DR_FIXTURE = {
  slug: 'self-test-dr',
  question: 'What is the capital of France?',
  frozenIso: '2025-01-02T03:04:05.000Z',
  sources: [
    {
      url: 'https://example.com/france',
      title: 'France',
      mediaType: 'text/markdown',
      content: '# France\n\nFrance is a country in Western Europe.\n',
      fetchedAtIso: '2025-01-02T03:04:06.000Z',
    },
    {
      url: 'https://example.com/paris',
      title: 'Paris',
      mediaType: 'text/markdown',
      content: '# Paris\n\nParis is the capital city of France.\n',
      fetchedAtIso: '2025-01-02T03:04:07.000Z',
    },
  ],
  plan: (): DeepResearchPlan => ({
    kind: 'deep-research',
    slug: 'self-test-dr',
    question: 'What is the capital of France?',
    status: 'done',
    budget: BUDGET,
    subQuestions: [
      {
        id: 'sq-1',
        question: 'What is the capital of France?',
        status: 'complete',
        findingsPath: 'findings/sq-1.md',
      },
    ],
  }),
  journalEntries: [
    { ts: '2025-01-02T03:04:05.000Z', level: 'step', heading: 'planner produced 1 sub-question' },
    { ts: '2025-01-02T03:04:08.000Z', level: 'step', heading: 'fanout dispatched' },
    { ts: '2025-01-02T03:04:09.000Z', level: 'step', heading: 'synthesis complete' },
  ] as const,
  finding: {
    id: 'sq-1',
    body: '# Finding: capital of France\n\nParis is the capital city of France.\n',
  },
  /**
   * Draft with placeholders; `<SRC-A>` / `<SRC-B>` are substituted
   * with the real computed source ids at run time so the golden
   * tree stays reproducible.
   */
  draft:
    '# Research Report\n\nParis is the capital of France. It is a major European city.\n\n' +
    'According to the fetched sources {{SRC:<SRC-A>}} {{SRC:<SRC-B>}}.\n',
};

/** Autoresearch fixture. One experiment, no sources. */
const AR_FIXTURE = {
  slug: 'self-test-ar',
  topic: 'measure sort algorithm wall-clock on fixed inputs',
  plan: (): AutoresearchPlan => ({
    kind: 'autoresearch',
    slug: 'self-test-ar',
    topic: 'measure sort algorithm wall-clock on fixed inputs',
    status: 'done',
    budget: BUDGET,
    experiments: [
      {
        id: 'e-1',
        hypothesis: 'Quicksort is faster than bubblesort on 10k random ints.',
        status: 'complete',
        dir: 'experiments/e-1',
        metricsSchema: {
          required: ['algorithm', 'inputSize', 'seconds'],
        },
      },
    ],
  }),
  journalEntries: [
    { ts: '2025-02-03T04:05:06.000Z', level: 'step', heading: 'plan authored' },
    { ts: '2025-02-03T04:05:07.000Z', level: 'step', heading: 'experiment e-1 running' },
    { ts: '2025-02-03T04:05:08.000Z', level: 'step', heading: 'experiment e-1 complete' },
  ] as const,
  experimentArtifacts: {
    hypothesisMd: '# Hypothesis\n\nQuicksort beats bubblesort on large random inputs.\n',
    metricsJson: {
      algorithm: 'quicksort',
      inputSize: 10_000,
      seconds: 0.125,
    },
  },
};

// ──────────────────────────────────────────────────────────────────────
// Mock McpClient used by the deep-research fetch step.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a mock `McpClient` that serves the fixture's URLs and
 * nothing else. Unknown URLs throw so an accidental pipeline
 * change (adding a new fetch without updating the fixture)
 * fails loudly rather than silently producing an empty source.
 */
function makeMockMcpClient(): McpClient {
  const bySource = new Map<string, { content: string; title: string; mediaType: string }>();
  for (const s of DR_FIXTURE.sources) {
    bySource.set(s.url, { content: s.content, title: s.title, mediaType: s.mediaType });
  }
  return {
    fetchUrl(input: McpFetchUrlInput): Promise<McpFetchUrlResult> {
      const entry = bySource.get(input.url);
      if (!entry) return Promise.reject(new Error(`selftest mcp: no fixture for ${input.url}`));
      return Promise.resolve({
        content: entry.content,
        url: input.url,
        title: entry.title,
        mediaType: entry.mediaType,
      });
    },
    convertHtml(): Promise<McpConvertHtmlResult> {
      return Promise.reject(new Error('selftest mcp: convertHtml not used'));
    },
    searchWeb(): Promise<McpSearchWebResult> {
      return Promise.reject(new Error('selftest mcp: searchWeb not used'));
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mini-pipelines
// ──────────────────────────────────────────────────────────────────────

/**
 * Drive the deep-research mini-pipeline to completion under
 * `root`. Writes happen through the real research-core primitives
 * so the selftest validates seams between modules, not just
 * module internals.
 */
async function runDeepResearchPipeline(root: string): Promise<void> {
  const p = paths(root);

  // 1. Plan.
  writePlan(p.plan, DR_FIXTURE.plan());

  // 2. Journal (frozen timestamps so the output is byte-stable).
  for (const entry of DR_FIXTURE.journalEntries) {
    appendJournal(p.journal, {
      level: entry.level,
      heading: entry.heading,
      ts: new Date(entry.ts),
    });
  }

  // 3. Sources - exercised through fetchAndStore + the mock MCP.
  const mcp = makeMockMcpClient();
  const refs: { url: string; id: string }[] = [];
  for (const s of DR_FIXTURE.sources) {
    const ref = await fetchAndStore(root, s.url, mcp, {
      now: () => new Date(s.fetchedAtIso),
    });
    refs.push({ url: s.url, id: ref.id });
  }

  // 4. Finding. Written directly - no subagent in the fixture
  //    path (the selftest is explicitly LLM-free).
  const findingPath = join(p.findings, `${DR_FIXTURE.finding.id}.md`);
  atomicWriteFile(findingPath, DR_FIXTURE.finding.body);

  // 5. Citation rewrite + report.
  const srcA = refs[0];
  const srcB = refs[1];
  const draft = DR_FIXTURE.draft.replace('<SRC-A>', srcA.id).replace('<SRC-B>', srcB.id);
  const index = new Map<string, CitationSource>([
    [srcA.id, { id: srcA.id, url: srcA.url, title: DR_FIXTURE.sources[0].title }],
    [srcB.id, { id: srcB.id, url: srcB.url, title: DR_FIXTURE.sources[1].title }],
  ]);
  const { report, footnotes } = renumber(draft, index);
  const reportBody = footnotes.length > 0 ? `${report}\n${footnotes}` : report;
  atomicWriteFile(p.report, reportBody);
}

/**
 * Drive the autoresearch mini-pipeline. No sources; the pipeline
 * is plan + journal + one experiment artifact dir.
 */
function runAutoresearchPipeline(root: string): void {
  const p = paths(root);

  writePlan(p.plan, AR_FIXTURE.plan());

  for (const entry of AR_FIXTURE.journalEntries) {
    appendJournal(p.journal, {
      level: entry.level,
      heading: entry.heading,
      ts: new Date(entry.ts),
    });
  }

  const expDir = join(p.experiments, 'e-1');
  atomicWriteFile(join(expDir, 'hypothesis.md'), AR_FIXTURE.experimentArtifacts.hypothesisMd);
  atomicWriteFile(
    join(expDir, 'metrics.json'),
    JSON.stringify(AR_FIXTURE.experimentArtifacts.metricsJson, null, 2) + '\n',
  );
}

// ──────────────────────────────────────────────────────────────────────
// Byte-for-byte tree comparison.
// ──────────────────────────────────────────────────────────────────────

/**
 * Recursively enumerate every file under `root`, returning paths
 * relative to `root` with forward-slash separators. Skips
 * directory entries - only file bytes are part of the contract.
 */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const abs = join(dir, name);
      const r = rel.length === 0 ? name : `${rel}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

function diffTrees(expectedRoot: string, actualRoot: string): SelftestDiff[] {
  const expectedFiles = new Set(listTree(expectedRoot));
  const actualFiles = new Set(listTree(actualRoot));
  const all = new Set([...expectedFiles, ...actualFiles]);
  const diffs: SelftestDiff[] = [];
  for (const rel of Array.from(all).sort()) {
    const inE = expectedFiles.has(rel);
    const inA = actualFiles.has(rel);
    if (inE && !inA) {
      diffs.push({ path: rel, kind: 'missing', expected: readFileSync(join(expectedRoot, rel), 'utf8') });
      continue;
    }
    if (!inE && inA) {
      diffs.push({ path: rel, kind: 'extra', actual: readFileSync(join(actualRoot, rel), 'utf8') });
      continue;
    }
    const expectedBody = readFileSync(join(expectedRoot, rel), 'utf8');
    const actualBody = readFileSync(join(actualRoot, rel), 'utf8');
    if (expectedBody !== actualBody) {
      diffs.push({ path: rel, kind: 'mismatch', expected: expectedBody, actual: actualBody });
    }
  }
  return diffs;
}

// ──────────────────────────────────────────────────────────────────────
// Fixture layout
// ──────────────────────────────────────────────────────────────────────

/** Absolute path of the `fixtures/<flow>/expected/` dir on disk. */
function fixtureExpectedDir(flow: 'deep-research' | 'autoresearch'): string {
  // This file lives at `lib/node/pi/research-selftest.ts`. The
  // fixture dir is the sibling `research-selftest/` directory. We
  // derive the path from `import.meta.url` so moving the file
  // doesn't silently break the resolution. `fileURLToPath` gives
  // us a proper absolute path across platforms (Linux, macOS,
  // WSL) without the `pathname`-of-a-URL quirks (drive-letter
  // prefixes on Windows, percent-encoded characters, etc.).
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, 'research-selftest', 'fixtures', flow, 'expected');
}

// ──────────────────────────────────────────────────────────────────────
// Public selftest entry points
// ──────────────────────────────────────────────────────────────────────

/**
 * Run the deep-research mini-pipeline and diff the result tree
 * against the committed golden. Returns a `SelftestResult` with
 * either `ok: true, diffs: []` or `ok: false, diffs: [...]` -
 * callers surface the diffs to the user.
 *
 * `opts.dryRun` returns an `ok: true` result without touching the
 * filesystem - useful for plumbing smoke tests that only want to
 * verify the function is callable.
 */
export async function selftestDeepResearch(opts: SelftestOpts): Promise<SelftestResult> {
  const actualRoot = runRoot(opts.cwd, DR_FIXTURE.slug);
  if (opts.dryRun) {
    return { ok: true, runRoot: actualRoot, diffs: [] };
  }
  await runDeepResearchPipeline(actualRoot);
  const diffs = diffTrees(fixtureExpectedDir('deep-research'), actualRoot);
  return { ok: diffs.length === 0, runRoot: actualRoot, diffs };
}

/**
 * Run the autoresearch mini-pipeline and diff the result tree
 * against the committed golden. Same shape as
 * `selftestDeepResearch`.
 */
export function selftestAutoresearch(opts: SelftestOpts): Promise<SelftestResult> {
  const actualRoot = labRoot(opts.cwd, AR_FIXTURE.slug);
  if (opts.dryRun) {
    return Promise.resolve({ ok: true, runRoot: actualRoot, diffs: [] });
  }
  runAutoresearchPipeline(actualRoot);
  const diffs = diffTrees(fixtureExpectedDir('autoresearch'), actualRoot);
  return Promise.resolve({ ok: diffs.length === 0, runRoot: actualRoot, diffs });
}

// ──────────────────────────────────────────────────────────────────────
// Golden regeneration - dev-time only.
// ──────────────────────────────────────────────────────────────────────

/**
 * Regenerate the committed `fixtures/deep-research/expected/`
 * tree from the current pipeline. Intended for use from a
 * one-shot dev script when a module's on-disk shape changes
 * intentionally - not from test code. Running this in CI would
 * silently mask regressions, so it is NOT wired into any test
 * path.
 *
 * Usage (from the repo root):
 *
 *     node --experimental-strip-types -e \
 *       'import("./lib/node/pi/research-selftest.ts").then(m => m.regenerateDeepResearchFixture())'
 */
export async function regenerateDeepResearchFixture(): Promise<string> {
  const dest = fixtureExpectedDir('deep-research');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await runDeepResearchPipeline(dest);
  return dest;
}

/** Analog for autoresearch. See {@link regenerateDeepResearchFixture}. */
export function regenerateAutoresearchFixture(): string {
  const dest = fixtureExpectedDir('autoresearch');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  runAutoresearchPipeline(dest);
  return dest;
}
