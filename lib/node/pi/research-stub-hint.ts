/* eslint-disable no-use-before-define -- TS function declarations are hoisted; ordering here is public API → helpers. */
/**
 * Format the Phase-4 stub-detection hint surfaced by the
 * deep-research extension after a review run.
 *
 * When the final `report.md` still contains `[section unavailable:
 * \u2026]` stubs emitted by `deep-research-synth-sections` on an empty
 * findings file, refinement cannot fix them \u2014 the user needs to
 * re-fetch those sub-questions. This helper walks the report,
 * resolves each stubbed heading to its `plan.subQuestions[*].id`,
 * and returns a copy-pasteable `/research --resume` command
 * scoped to the exact ids.
 *
 * The extension used to fall back to `rm ${runRoot}/findings/<id>.md`
 * before Phase-3 shipped `--sq` targeting. That workaround is
 * gone; this helper always emits a real `--sq=<ids>` command.
 * When one or more headings can't be matched (heading prose
 * drifted from the plan, or two sub-questions share the same
 * prose so the match is ambiguous), the helper degrades to a
 * `--sq=<id1>,<id2>` placeholder plus a pointer at `plan.json`
 * so the shape still copy-pastes into a working command.
 *
 * Pure + advisory: missing / unreadable `report.md` returns
 * `null` (no stubs \u2192 no hint); a malformed `plan.json` is
 * swallowed and falls through to the placeholder path. This
 * helper must never throw into the notify path.
 */

import { paths } from './research-paths.ts';
import { readPlan } from './research-plan.ts';
import { type StubbedSection, findStubbedSections } from './research-resume.ts';

/** Matches the reduced shape {@link formatStubHint} needs from the plan. */
interface PlanSubQuestionHandle {
  id: string;
  question: string;
}

/**
 * Build the hint string for `runRoot`, or `null` when there are
 * no stubbed sections in the rendered report (the common case).
 *
 * Resolution strategy:
 *   1. Exact-string match between the H2 heading and
 *      `plan.subQuestions[*].question`.
 *   2. Case-insensitive trimmed match, picking the single bucket
 *      member when the normalized heading appears exactly once.
 *   3. Give up \u2192 placeholder path for that heading.
 *
 * When any heading fails to resolve, the helper emits the
 * placeholder command for the whole hint so the copy-paste never
 * mixes real ids with `<id1>` markers. Keeping the ambiguity
 * signal as an all-or-nothing branch matches how users read the
 * notify: the command line either works verbatim or it's a
 * template they fill in.
 */
export function formatStubHint(runRoot: string): string | null {
  const p = paths(runRoot);
  const stubbed = findStubbedSections(p.report);
  if (stubbed.length === 0) return null;

  const subQuestions = readPlanSubQuestions(p.plan);
  const resolved = resolveHeadings(stubbed, subQuestions);

  const lines: string[] = [];
  lines.push(`/research: note \u2014 ${stubbed.length} sub-question section(s) are stubbed as [section unavailable].`);
  for (const s of stubbed) {
    const reason = s.reason.length > 0 ? ` \u2014 ${s.reason}` : '';
    lines.push(`  \u2022 ${s.heading}${reason}`);
  }
  if (resolved.ok) {
    lines.push(
      `  To re-fetch: \`/research --resume --run-root ${runRoot} --from=fanout --sq=${resolved.ids.join(',')}\``,
    );
  } else {
    lines.push(
      `  To re-fetch: \`/research --resume --run-root ${runRoot} --from=fanout --sq=<id1>,<id2>\`` +
        ` (could not resolve every heading above to a plan sub-question id; open ${p.plan} to map them).`,
    );
  }
  return lines.join('\n');
}

function readPlanSubQuestions(planPath: string): PlanSubQuestionHandle[] {
  try {
    const plan = readPlan(planPath);
    if (plan.kind !== 'deep-research') return [];
    return plan.subQuestions.map((sq) => ({ id: sq.id, question: sq.question }));
  } catch {
    /* advisory hint \u2014 never break on a malformed plan.json */
    return [];
  }
}

interface ResolvedHeadings {
  ok: boolean;
  ids: string[];
}

function resolveHeadings(
  stubbed: readonly StubbedSection[],
  subQuestions: readonly PlanSubQuestionHandle[],
): ResolvedHeadings {
  const norm = (s: string): string => s.trim().toLowerCase();
  const byExact = new Map<string, string>();
  const byNorm = new Map<string, string[]>();
  for (const sq of subQuestions) {
    // First occurrence wins on exact-match; ambiguity on the
    // normalized key is handled by `byNorm` below.
    if (!byExact.has(sq.question)) byExact.set(sq.question, sq.id);
    const key = norm(sq.question);
    const bucket = byNorm.get(key);
    if (bucket) bucket.push(sq.id);
    else byNorm.set(key, [sq.id]);
  }

  const ids: string[] = [];
  let ok = stubbed.length > 0;
  for (const s of stubbed) {
    const exact = byExact.get(s.heading);
    if (exact !== undefined) {
      ids.push(exact);
      continue;
    }
    const bucket = byNorm.get(norm(s.heading));
    if (bucket?.length === 1) {
      ids.push(bucket[0]);
      continue;
    }
    ok = false;
  }
  return { ok, ids };
}
