/**
 * Phase 6 (source-store populate) + Phase 3 (synth+merge) drivers for
 * the deep-research pipeline. Split out of
 * `./deep-research-pipeline.ts` so the orchestrator stays focused on
 * sequencing the stages and the source-store / synth orchestration
 * can be reasoned about - and tested - independently.
 *
 * Both functions are pure orchestrators: they read prior-phase state
 * off disk, call the underlying stage modules (`research-sources`,
 * `deep-research-synth-sections`, `deep-research-synth-merge`), and
 * emit progress events via the injected `deps.onPhase` hook.
 *
 * No new public surface - the orchestrator just imports these
 * helpers. They were exported here (rather than living as
 * file-private functions inside the orchestrator module) so the
 * split is mechanical and the orchestrator's imports stay obvious.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDirSync } from '../atomic-write.ts';
import { extractFindingSourceUrls } from './finding.ts';
import type { PipelineDeps } from './pipeline.ts';
import { type SynthMergeResult, runSynthMerge } from './synth-merge.ts';
import { type SectionOutcome, runAllSections } from './synth-sections.ts';
import { appendJournal } from '../research/journal.ts';
import { paths } from '../research/paths.ts';
import { type DeepResearchPlan } from '../research/plan.ts';
import { fetchAndStore, listRun, type SourceRef } from '../research/sources.ts';
import { type ResearchSessionLike } from '../research/structured.ts';

interface PopulateArgs<M> {
  plan: DeepResearchPlan;
  runRoot: string;
  /** Sub-question ids whose findings did not survive absorb. */
  quarantined: ReadonlySet<string>;
  deps: PipelineDeps<M>;
}

/**
 * For each accepted finding on disk, walk its `## Sources` block and
 * call `fetchAndStore` for every URL. This is the ONLY step that
 * populates `sources/<hash>.md` + `<hash>.json`; without it the synth
 * stage drops every citation because `collectReferencedSources`
 * filters by the on-disk source index.
 *
 * Cost-aware: `fetchAndStore` hits the on-disk cache first, so a
 * second `/research --resume` run does zero network work. Bounded by
 * `plan.budget.maxFetches` to match the planner's contract; a
 * finding that cites more than the budget allows gets its extra URLs
 * dropped (with a journal warning) rather than busting the budget.
 *
 * Only *network* fetches (`method === 'fetch'`) count toward
 * `maxFetches`; cache hits are free and never consume budget. Without
 * this, a `--resume` run - where every citation is already cached -
 * would count cache hits toward the cap and drop the never-fetched
 * URLs past the limit, silently losing citations the first run had
 * fully populated.
 *
 * Degrades gracefully when `deps.mcpClient` is unset - journal a
 * one-shot warning and return. The downstream synth stage will still
 * run but produce zero-citation sections; structural check will fail
 * the refinement loop, which is the right outcome for a pipeline
 * that lost its fetch capability.
 */
export async function populateSourceStore<M>(args: PopulateArgs<M>): Promise<void> {
  const { plan, runRoot, quarantined, deps } = args;
  const p = paths(runRoot);
  const client = deps.mcpClient;
  if (!client) {
    try {
      appendJournal(p.journal, {
        level: 'warn',
        heading: 'source-store populate skipped',
        body: 'no McpClient injected - synth will produce zero-citation sections unless a downstream cache is populated by other means.',
      });
    } catch {
      /* swallow */
    }
    return;
  }

  const maxFetches = plan.budget.maxFetches;
  let fetched = 0;
  let cacheHits = 0;
  let failed = 0;
  let dropped = 0;
  const seen = new Set<string>();
  const nowFactory = deps.now ? { now: deps.now } : {};

  for (const sq of plan.subQuestions) {
    if (quarantined.has(sq.id)) continue;
    const findingPath = join(p.findings, `${sq.id}.md`);
    let body: string;
    try {
      body = readFileSync(findingPath, 'utf8');
    } catch {
      continue;
    }
    const urls = extractFindingSourceUrls(body);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      // Only real network fetches consume the budget; a cache hit is
      // free, so gate on `fetched` alone. This keeps a `--resume` run
      // (all-cached) from dropping citations once it passes the cap.
      if (fetched >= maxFetches) {
        dropped += 1;
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential fetch keeps MCP rate-limit headroom
        const ref = await fetchAndStore(runRoot, url, client, nowFactory);
        if (ref.method === 'cached') cacheHits += 1;
        else if (ref.method === 'fetch') fetched += 1;
        else failed += 1;
      } catch (e) {
        failed += 1;
        try {
          appendJournal(p.journal, {
            level: 'warn',
            heading: `source-store fetch failed for ${url}`,
            body: (e as Error).message,
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  try {
    appendJournal(p.journal, {
      level: 'step',
      heading: 'source-store populated',
      body: `fetched=${fetched} cached=${cacheHits} failed=${failed} dropped=${dropped} cap=${maxFetches}`,
    });
  } catch {
    /* swallow */
  }
}

interface SynthPhaseArgs<M> {
  runRoot: string;
  plan: DeepResearchPlan;
  session: ResearchSessionLike;
  deps: PipelineDeps<M>;
  /** Sub-question ids whose findings were quarantined upstream. */
  quarantinedFindings: ReadonlySet<string>;
}

/**
 * Drive `runAllSections` then `runSynthMerge` against the parent
 * session. The source index is loaded once and shared between both
 * stages; everything else (tiny adapter, clock, journal path)
 * threads through unchanged.
 *
 * Errors from `runSynthMerge` (notably {@link UnknownPlaceholderError})
 * propagate - the caller maps them to a `{kind:'error'}` outcome.
 */
export async function runSynthPhase<M>(args: SynthPhaseArgs<M>): Promise<{
  sections: SectionOutcome[];
  merge: SynthMergeResult;
}> {
  const { runRoot, plan, session, deps, quarantinedFindings } = args;
  const p = paths(runRoot);
  ensureDirSync(runRoot);

  // One listing used by both stages - `research-sources.listRun` is
  // O(N) in the source store size; not load-bearing for speed but
  // avoids doing it twice.
  const sourceIndex: SourceRef[] = listRun(runRoot);

  let sectionsDone = 0;
  const sections = await runAllSections<M>({
    runRoot,
    plan,
    session,
    model: deps.model,
    thinkingLevel: deps.thinkingLevel,
    quarantinedFindings,
    sourceIndex,
    journalPath: p.journal,
    onSection: (): void => {
      sectionsDone += 1;
      if (deps.onPhase) {
        try {
          deps.onPhase({
            kind: 'synth-progress',
            done: sectionsDone,
            total: plan.subQuestions.length,
          });
        } catch {
          /* swallow - observability hook failures are never load-bearing */
        }
      }
    },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
    ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
    ...(deps.synthSubQuestionIds && deps.synthSubQuestionIds.length > 0
      ? { subQuestionIds: deps.synthSubQuestionIds }
      : {}),
  });

  if (deps.onPhase) {
    try {
      deps.onPhase({ kind: 'merge' });
    } catch {
      /* swallow */
    }
  }
  const merge = await runSynthMerge<M>({
    runRoot,
    plan,
    sectionOutcomes: sections,
    session,
    model: deps.model,
    thinkingLevel: deps.thinkingLevel,
    sourceIndex,
    journalPath: p.journal,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
    ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
  });
  return { sections, merge };
}
