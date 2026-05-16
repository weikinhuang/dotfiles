// Improver prompt template for the description-optimization loop (R4).
//
// Port of `improve_description.py` from Claude Code's skill-creator. Pure
// prompt assembly + response parsing - no I/O, no driver spawn. The
// optimizer wires this into the same `invokeDriver` path the trigger eval
// uses.
//
// Two prompt variants:
//
//   1. {@link buildImproverPrompt} - the primary single-turn call. Includes
//      the current description, per-eval failure summary, *blinded* history
//      of previous attempts (test_* keys stripped by the caller), and the
//      full SKILL.md body as context. Response is expected to be wrapped in
//      `<new_description>…</new_description>`.
//
//   2. {@link buildShortenPrompt} - the 1024-char safety net. The primary
//      prompt states the 1024-char hard limit, but a model may still blow
//      past it. When that happens, we issue a fresh single-turn call that
//      quotes the too-long version verbatim and asks for a rewrite.
//
// SPDX-License-Identifier: MIT

/**
 * Per-query trigger result fed into the improver prompt. Subset of the full
 * grade record - we only surface the bits the improver cares about.
 */
export interface ImproverTriggerResult {
  query: string;
  should_trigger: boolean;
  triggers: number;
  runs: number;
  pass: boolean;
}

/**
 * History entry for a previous optimizer iteration. The optimizer strips
 * `test_*` keys before passing this in ("history blinding"), so the
 * improver can't overfit to held-out scores. We also accept an optional
 * `note` field mirroring the Python original.
 */
export interface ImproverHistoryEntry {
  iteration: number;
  description: string;
  train_passed?: number;
  train_total?: number;
  train_results?: ImproverTriggerResult[];
  note?: string;
}

export interface BuildImproverPromptInput {
  skillName: string;
  skillContent: string;
  currentDescription: string;
  trainResults: readonly ImproverTriggerResult[];
  trainSummary: { passed: number; total: number };
  testSummary: { passed: number; total: number } | null;
  /** Pre-blinded history (caller strips `test_*` fields). */
  blindedHistory: readonly ImproverHistoryEntry[];
}

/** Clip a query for compact display in the prompt so long scenarios don't blow the budget. */
function clipQuery(q: string, max: number): string {
  if (q.length <= max) return q;
  return `${q.slice(0, max - 1)}…`;
}

/**
 * Strip `test_*` keys from a history entry. The optimizer is responsible
 * for calling this before passing history into {@link buildImproverPrompt};
 * we expose it as a pure helper so the spec can round-trip the rule.
 */
export function blindHistoryEntry<T extends Record<string, unknown>>(entry: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k.startsWith('test_')) continue;
    out[k] = v;
  }
  return out as T;
}

/**
 * Build the single-turn improver prompt. The prompt body is a near-verbatim
 * port of `improve_description.py`'s prompt so existing ergonomics carry
 * over - the imperative-voice tips, the "don't overfit" guidance, and the
 * hard 1024-char reminder.
 */
export function buildImproverPrompt(input: BuildImproverPromptInput): string {
  const failed = input.trainResults.filter((r) => r.should_trigger && !r.pass);
  const falseTriggers = input.trainResults.filter((r) => !r.should_trigger && !r.pass);
  const trainScore = `${input.trainSummary.passed}/${input.trainSummary.total}`;
  const scoresSummary = input.testSummary
    ? `Train: ${trainScore}, Test: ${input.testSummary.passed}/${input.testSummary.total}`
    : `Train: ${trainScore}`;

  const lines: string[] = [];
  lines.push(
    `You are optimizing a skill description for a skill called "${input.skillName}". A "skill" is sort of like a prompt, but with progressive disclosure - there's a title and description that an AI coding assistant sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder.`,
    '',
    `The description appears in the assistant's "available_skills" list. When a user sends a query, the assistant decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.`,
    '',
    "Here's the current description:",
    '<current_description>',
    `"${input.currentDescription}"`,
    '</current_description>',
    '',
    `Current scores (${scoresSummary}):`,
    '<scores_summary>',
  );

  if (failed.length > 0) {
    lines.push("FAILED TO TRIGGER (should have triggered but didn't):");
    for (const r of failed) {
      lines.push(`  - "${clipQuery(r.query, 140)}" (triggered ${r.triggers}/${r.runs} times)`);
    }
    lines.push('');
  }
  if (falseTriggers.length > 0) {
    lines.push("FALSE TRIGGERS (triggered but shouldn't have):");
    for (const r of falseTriggers) {
      lines.push(`  - "${clipQuery(r.query, 140)}" (triggered ${r.triggers}/${r.runs} times)`);
    }
    lines.push('');
  }

  if (input.blindedHistory.length > 0) {
    lines.push('PREVIOUS ATTEMPTS (do NOT repeat these - try something structurally different):', '');
    for (const h of input.blindedHistory) {
      const tp = h.train_passed ?? 0;
      const tt = h.train_total ?? 0;
      lines.push(`<attempt train=${tp}/${tt}>`);
      lines.push(`Description: "${h.description}"`);
      if (h.train_results && h.train_results.length > 0) {
        lines.push('Train results:');
        for (const r of h.train_results) {
          const status = r.pass ? 'PASS' : 'FAIL';
          lines.push(`  [${status}] "${clipQuery(r.query, 80)}" (triggered ${r.triggers}/${r.runs})`);
        }
      }
      if (h.note) lines.push(`Note: ${h.note}`);
      lines.push('</attempt>', '');
    }
  }

  lines.push(
    '</scores_summary>',
    '',
    'Skill content (for context on what the skill does):',
    '<skill_content>',
    input.skillContent,
    '</skill_content>',
    '',
    "Based on the failures, write a new and improved description that is more likely to trigger correctly. When I say \"based on the failures\", it's a bit of a tricky line to walk because we don't want to overfit to the specific cases you're seeing. So what I DON'T want you to do is produce an ever-expanding list of specific queries that this skill should or shouldn't trigger for. Instead, try to generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful. The reason for this is twofold:",
    '',
    '1. Avoid overfitting',
    "2. The list might get loooong and it's injected into ALL queries and there might be a lot of skills, so we don't want to blow too much space on any given description.",
    '',
    'Concretely, your description should not be more than about 100-200 words, even if that comes at the cost of accuracy. There is a 1024-character hard limit - descriptions over that will be truncated, so stay comfortably under it.',
    '',
    "Here are some tips that we've found to work well in writing these descriptions:",
    '- The skill should be phrased in the imperative - "Use this skill for" rather than "this skill does"',
    "- The skill description should focus on the user's intent, what they are trying to achieve, vs. the implementation details of how the skill works.",
    "- The description competes with other skills for the assistant's attention - make it distinctive and immediately recognizable.",
    "- If you're getting lots of failures after repeated attempts, change things up. Try different sentence structures or wordings.",
    '',
    "I'd encourage you to be creative and mix up the style in different iterations since you'll have multiple opportunities to try different approaches and we'll just grab the highest-scoring one at the end.",
    '',
    'Please respond with only the new description text in <new_description> tags, nothing else.',
  );

  return lines.join('\n');
}

/**
 * The 1024-char safety-net prompt. Quotes the over-length description
 * verbatim inside the original prompt's scope so the model has full
 * context of what it was asked to do, plus a direct "rewrite it shorter"
 * instruction. Returned prompt still uses the `<new_description>` tag
 * contract.
 */
export function buildShortenPrompt(originalPrompt: string, overLong: string): string {
  return [
    originalPrompt,
    '',
    '---',
    '',
    `A previous attempt produced this description, which at ${overLong.length} characters is over the 1024-character hard limit:`,
    '',
    `"${overLong}"`,
    '',
    'Rewrite it to be under 1024 characters while keeping the most important trigger words and intent coverage. Respond with only the new description in <new_description> tags.',
  ].join('\n');
}

/**
 * Pull the new description out of the improver's reply. Prefers content
 * inside `<new_description>…</new_description>` tags; falls back to the
 * entire trimmed response when tags are missing. Surrounding single or
 * double quotes are stripped (Claude sometimes emits them), and leading /
 * trailing whitespace collapses.
 */
export function parseNewDescription(text: string): string {
  const m = /<new_description>([\s\S]*?)<\/new_description>/i.exec(text);
  const inner = m?.[1] ?? text;
  let out = inner.trim();
  // Strip a single layer of surrounding quotes.
  if (out.length >= 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      out = out.slice(1, -1).trim();
    }
  }
  return out;
}

/** 1024-char hard limit enforced by the frontmatter schema. */
export const MAX_DESCRIPTION_CHARS = 1024;
