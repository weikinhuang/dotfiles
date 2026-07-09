/**
 * Tests for lib/node/pi/deep-research/synth-pipeline.ts.
 *
 * Focused regression coverage for the source-store populate step's
 * budget accounting (#6): only real network fetches
 * (`method === 'fetch'`) may consume `plan.budget.maxFetches`; cache
 * hits are free. Without this a `--resume` run - where every citation
 * is already cached - would count cache hits toward the cap and drop
 * the URLs past the limit, silently losing citations.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type {
  PipelineDeps,
  ResearchSessionLikeWithLifecycle,
} from '../../../../../lib/node/pi/deep-research/pipeline.ts';
import { populateSourceStore } from '../../../../../lib/node/pi/deep-research/synth-pipeline.ts';
import { paths } from '../../../../../lib/node/pi/research/paths.ts';
import { type DeepResearchPlan, type PlanBudget, writePlan } from '../../../../../lib/node/pi/research/plan.ts';
import { type McpClient, type McpFetchUrlResult } from '../../../../../lib/node/pi/research/sources.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures.
// ──────────────────────────────────────────────────────────────────────

function findingWithSources(id: string, urls: readonly string[]): string {
  const sourceLines = urls.map((url, i) => `- [S${i + 1}] ${url} - description ${i + 1}`);
  return [
    `# Sub-question: question for ${id}`,
    '',
    '## Findings',
    ...urls.map((_, i) => `- claim citing [S${i + 1}]`),
    '',
    '## Sources',
    ...sourceLines,
    '',
    '## Open questions',
    '- None.',
    '',
  ].join('\n');
}

function makePlan(runRootSlug: string, ids: readonly string[], budget: PlanBudget): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: runRootSlug,
    question: 'seeded question',
    status: 'planning',
    budget,
    subQuestions: ids.map((id) => ({ id, question: `question for ${id}`, status: 'pending' as const })),
  };
}

/** Counts fetchUrl invocations so cache hits are observable. */
function countingMcpClient(counter: { calls: number }): McpClient {
  return {
    fetchUrl: (input: { url: string }): Promise<McpFetchUrlResult> => {
      counter.calls += 1;
      return Promise.resolve({ content: `# Cached page for ${input.url}`, url: input.url, title: 'Page' });
    },
    convertHtml: () => Promise.reject(new Error('unused')),
    searchWeb: () => Promise.reject(new Error('unused')),
  };
}

/**
 * Build a minimal but fully-typed {@link PipelineDeps}. `populateSourceStore`
 * only reads `mcpClient` + `now`; the rest are inert stubs that throw if
 * ever called so an accidental dependency is loud rather than silent.
 */
function makeDeps(cwd: string, mcpClient: McpClient): PipelineDeps<unknown> {
  return {
    cwd,
    createSession: (): Promise<ResearchSessionLikeWithLifecycle> =>
      Promise.reject(new Error('createSession must not be called')),
    runPlanningCritic: () => Promise.reject(new Error('runPlanningCritic must not be called')),
    fanoutSpawn: () => Promise.reject(new Error('fanoutSpawn must not be called')),
    fanoutMode: 'sync',
    model: 'm/x',
    thinkingLevel: null,
    mcpClient,
  };
}

function readJournal(runRoot: string): string {
  const p = paths(runRoot).journal;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

// ──────────────────────────────────────────────────────────────────────
// Tests.
// ──────────────────────────────────────────────────────────────────────

describe('populateSourceStore - fetch budget accounting (#6)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'synth-pipeline-'));
  });

  afterEach(() => {
    // best-effort; OS tmp reaper handles the rest.
  });

  test('cache hits do NOT count toward maxFetches - a resume keeps every citation', async () => {
    const slug = 'resume-cache';
    const runRoot = join(sandbox, 'research', slug);
    mkdirSync(join(runRoot, 'findings'), { recursive: true });

    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    // Two sub-questions, one distinct URL each → 2 unique URLs.
    writeFileSync(join(runRoot, 'findings', 'sq-1.md'), findingWithSources('sq-1', [urlA]));
    writeFileSync(join(runRoot, 'findings', 'sq-2.md'), findingWithSources('sq-2', [urlB]));

    const counter = { calls: 0 };
    const deps = makeDeps(sandbox, countingMcpClient(counter));

    // Warm the cache with a generous budget: both URLs fetch over the
    // network.
    const warmPlan = makePlan(slug, ['sq-1', 'sq-2'], {
      maxSubagents: 6,
      maxFetches: 10,
      maxCostUsd: 3,
      wallClockSec: 1800,
    });
    writePlan(paths(runRoot).plan, warmPlan);
    await populateSourceStore({ plan: warmPlan, runRoot, quarantined: new Set<string>(), deps });

    expect(counter.calls).toBe(2);
    const warmJournal = readJournal(runRoot);
    expect(warmJournal).toContain('fetched=2 cached=0 failed=0 dropped=0');

    // Simulate a resume with a tight budget (maxFetches=1). Both URLs
    // are cached now, so nothing hits the network and - critically -
    // nothing is dropped even though maxFetches < number of URLs.
    const resumePlan = makePlan(slug, ['sq-1', 'sq-2'], {
      maxSubagents: 6,
      maxFetches: 1,
      maxCostUsd: 3,
      wallClockSec: 1800,
    });
    await populateSourceStore({ plan: resumePlan, runRoot, quarantined: new Set<string>(), deps });

    // No new network calls on resume.
    expect(counter.calls).toBe(2);
    const resumeJournal = readJournal(runRoot);
    expect(resumeJournal).toContain('fetched=0 cached=2 failed=0 dropped=0');
  });

  test('real fetches are still capped by maxFetches', async () => {
    const slug = 'fresh-cap';
    const runRoot = join(sandbox, 'research', slug);
    mkdirSync(join(runRoot, 'findings'), { recursive: true });

    // One sub-question citing three distinct, uncached URLs.
    writeFileSync(
      join(runRoot, 'findings', 'sq-1.md'),
      findingWithSources('sq-1', ['https://example.com/1', 'https://example.com/2', 'https://example.com/3']),
    );

    const counter = { calls: 0 };
    const deps = makeDeps(sandbox, countingMcpClient(counter));
    const plan = makePlan(slug, ['sq-1'], { maxSubagents: 6, maxFetches: 2, maxCostUsd: 3, wallClockSec: 1800 });
    writePlan(paths(runRoot).plan, plan);

    await populateSourceStore({ plan, runRoot, quarantined: new Set<string>(), deps });

    // Only two network fetches allowed; the third URL is dropped.
    expect(counter.calls).toBe(2);
    expect(readJournal(runRoot)).toContain('fetched=2 cached=0 failed=0 dropped=1');
  });
});
