/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Deep-research finding validator + quarantine orchestration.
 *
 * After the fanout's `web-researcher` subagents return their
 * per-sub-question `findings/<id>.md` files, the parent extension
 * inspects each one against the strict header schema declared in
 * `config/pi/agents/web-researcher.md`:
 *
 *     # Sub-question: <...>
 *     ## Findings
 *     ## Sources
 *     ## Open questions
 *
 * Malformed output triggers exactly ONE re-prompt ("previous
 * output didn't match required headers: <diff>. Rewrite."); a
 * second malformed result quarantines the sub-question into
 * `findings/_quarantined/<subq>/<timestamp>/` and tells the synth
 * stage that this sub-question has no usable findings.
 *
 * This module is the pure part of that pipeline:
 *
 *   - {@link validateFindingText} - shape checker against the
 *     schema, returns a structured diff usable both as a
 *     pass/fail signal AND as the body of the re-prompt.
 *   - {@link renderRePrompt} - build the "here's what you did
 *     wrong, rewrite the file" turn fed back to the fanout
 *     driver.
 *   - {@link classifyFindings} - decide, given the current
 *     failure-counter state for a sub-question, whether to
 *     accept / re-prompt / quarantine.
 *
 * All of the above is pi-runtime-free. The extension wires the
 * re-prompt dispatch + `research-quarantine.quarantine` call onto
 * these outputs.
 *
 * Optional tiny-model integration: source-title normalization.
 * When the adapter is enabled, we rewrite each `## Sources` entry's
 * human description through `callTinyRewrite(ctx, "normalize-title",
 * ...)` before the file is accepted. Classification errors / tiny
 * failures keep the original title - this is decorative only.
 */

import { existsSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';

// ──────────────────────────────────────────────────────────────────────
// Schema constants.
// ──────────────────────────────────────────────────────────────────────

export const FINDING_HEADINGS = {
  title: '# Sub-question:',
  findings: '## Findings',
  sources: '## Sources',
  openQuestions: '## Open questions',
} as const;

/** Max characters we accept before truncating + warning. */
export const FINDING_MAX_CHARS = 4000;

/** Max number of re-prompt attempts before we quarantine. */
export const FINDING_MAX_REPROMPTS = 1;

// ──────────────────────────────────────────────────────────────────────
// Validator.
// ──────────────────────────────────────────────────────────────────────

export interface FindingValidationOk {
  ok: true;
  /** Normalized body ready to land as-is on disk. */
  normalized: string;
  /** True when truncation took place to satisfy the cap. */
  truncated: boolean;
  /**
   * Structured view of the parsed sections - handed to the
   * source-title normalization pass if the tiny adapter is active.
   */
  sections: {
    subQuestion: string;
    findings: string;
    sources: string;
    openQuestions: string;
  };
}

export interface FindingValidationFail {
  ok: false;
  /** Human-readable diff suitable for echoing back to the model. */
  diff: string;
  /** Structured list of what was wrong (for journaling). */
  issues: string[];
}

export type FindingValidation = FindingValidationOk | FindingValidationFail;

/**
 * Check `text` against the web-researcher schema. Returns
 * {@link FindingValidationOk} with a normalized copy when the
 * schema holds, or {@link FindingValidationFail} with a structured
 * diff the caller can paste into the re-prompt.
 */
export function validateFindingText(text: string): FindingValidation {
  const issues: string[] = [];
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, diff: 'file is empty', issues: ['file is empty'] };
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? '';
  if (!firstLine.startsWith(FINDING_HEADINGS.title + ' ')) {
    issues.push(`first line must begin with "${FINDING_HEADINGS.title} <text>"; saw ${quotePreview(firstLine)}`);
  }

  // Scan for each heading. Order matters: Findings → Sources → Open
  // questions. We track the line number each heading was found on;
  // missing or out-of-order headings become issues.
  const findings = findHeadingLine(lines, FINDING_HEADINGS.findings);
  const sources = findHeadingLine(lines, FINDING_HEADINGS.sources);
  const openQuestions = findHeadingLine(lines, FINDING_HEADINGS.openQuestions);

  if (findings < 0) issues.push(`missing section "${FINDING_HEADINGS.findings}"`);
  if (sources < 0) issues.push(`missing section "${FINDING_HEADINGS.sources}"`);
  if (openQuestions < 0) issues.push(`missing section "${FINDING_HEADINGS.openQuestions}"`);

  // Order check - only meaningful when all three are present.
  if (findings >= 0 && sources >= 0 && openQuestions >= 0) {
    if (!(findings < sources && sources < openQuestions)) {
      issues.push(
        `sections must appear in order: ${FINDING_HEADINGS.findings} → ${FINDING_HEADINGS.sources} → ${FINDING_HEADINGS.openQuestions}`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, diff: issues.map((i) => `- ${i}`).join('\n'), issues };
  }

  // Gather section bodies (text between heading and next heading).
  const subQuestion = firstLine.slice(FINDING_HEADINGS.title.length).trim();
  if (subQuestion.length === 0) {
    return {
      ok: false,
      diff: '- sub-question title body is empty after "# Sub-question:"',
      issues: ['sub-question title body empty'],
    };
  }

  const findingsBody = sliceSection(lines, findings, sources);
  const sourcesBody = sliceSection(lines, sources, openQuestions);
  const openBody = sliceSection(lines, openQuestions, lines.length);

  // Truncate if over cap; keep the normalized body stable.
  let normalized = trimmed;
  let truncated = false;
  if (normalized.length > FINDING_MAX_CHARS) {
    normalized = normalized.slice(0, FINDING_MAX_CHARS - 32).trimEnd() + '\n\n<!-- truncated -->\n';
    truncated = true;
  }

  return {
    ok: true,
    normalized,
    truncated,
    sections: {
      subQuestion,
      findings: findingsBody.trim(),
      sources: sourcesBody.trim(),
      openQuestions: openBody.trim(),
    },
  };
}

function findHeadingLine(lines: readonly string[], heading: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) return i;
  }
  return -1;
}

function sliceSection(lines: readonly string[], start: number, end: number): string {
  if (start < 0) return '';
  const lo = start + 1;
  const hi = end < 0 ? lines.length : end;
  return lines.slice(lo, hi).join('\n');
}

function quotePreview(s: string): string {
  const max = 80;
  const body = s.length > max ? s.slice(0, max) + '…' : s;
  return JSON.stringify(body);
}

// ──────────────────────────────────────────────────────────────────────
// Re-prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the exact re-prompt the fanout driver feeds back into the
 * same web-researcher session. Matches the phrasing documented in
 * the agent definition so the model recognizes the re-prompt
 * shape.
 */
export function renderRePrompt(failure: FindingValidationFail, subQuestionId: string): string {
  return [
    `previous output didn't match required headers for sub-question ${subQuestionId}:`,
    failure.diff,
    '',
    'Rewrite the findings file so it matches the schema exactly:',
    '',
    '  # Sub-question: <verbatim>',
    '',
    '  ## Findings',
    '  - bullet cites [S1], [S2] …',
    '',
    '  ## Sources',
    '  - [S1] <URL> - <short description>',
    '',
    '  ## Open questions',
    '  - bullet, or "None."',
    '',
    'Write the full file in a single `write` call, then return a short confirmation and stop.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Failure-counter classification.
// ──────────────────────────────────────────────────────────────────────

export type FindingAction =
  | { kind: 'accept'; normalized: string; truncated: boolean; sections: FindingValidationOk['sections'] }
  | { kind: 'reprompt'; reprompt: string; priorFailures: number }
  | { kind: 'quarantine'; reason: string };

/**
 * Given a validation result AND the prior failure-counter for this
 * sub-question, decide whether to accept, ask for one re-prompt, or
 * quarantine. The counter is owned by the caller (see
 * `research-quarantine.failureCounter`) - we're pure.
 */
export function classifyFindings(args: { text: string; subQuestionId: string; priorFailures: number }): FindingAction {
  const validation = validateFindingText(args.text);
  if (validation.ok) {
    return {
      kind: 'accept',
      normalized: validation.normalized,
      truncated: validation.truncated,
      sections: validation.sections,
    };
  }
  if (args.priorFailures >= FINDING_MAX_REPROMPTS) {
    return {
      kind: 'quarantine',
      reason: `malformed findings after ${args.priorFailures + 1} attempts:\n${validation.diff}`,
    };
  }
  return {
    kind: 'reprompt',
    reprompt: renderRePrompt(validation, args.subQuestionId),
    priorFailures: args.priorFailures,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tiny-model source-title normalization (optional).
// ──────────────────────────────────────────────────────────────────────

const SOURCE_LINE_RE = /^- \[(S\d+)\] (\S+)(?: - (.*))?$/;

/**
 * Extract the URLs cited in a finding's `## Sources` section, in
 * document order. The finding schema (see the agent definition at
 * `config/pi/agents/web-researcher.md`) emits lines of the form
 *
 *     - [S1] <URL> - <description>
 *
 * and `## Sources` is bounded by the next `## ` heading. Lines
 * that don't match {@link SOURCE_LINE_RE} are skipped silently
 * so a free-form `## Sources` preamble doesn't spuriously
 * promote non-URL tokens.
 *
 * Exported so the synth stage (which needs to resolve each cited
 * URL back to a source-store id) doesn't re-implement the schema.
 * Keeping the parser co-located with the regex keeps the "the
 * finding schema lives here" contract intact.
 *
 * Tolerant on input - a body with no `## Sources` section, or an
 * empty one, returns `[]`.
 */
export function extractFindingSourceUrls(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const urls: string[] = [];
  let inSources = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === FINDING_HEADINGS.sources) {
      inSources = true;
      continue;
    }
    if (inSources && trimmed.startsWith('## ')) break;
    if (!inSources) continue;
    const m = SOURCE_LINE_RE.exec(line);
    if (m) urls.push(m[2]);
  }
  return urls;
}

export interface NormalizeSourceTitlesOpts<M> {
  sections: FindingValidationOk['sections'];
  adapter?: TinyAdapter<M>;
  ctx?: TinyCallContext<M>;
}

/**
 * For each `## Sources` entry, rewrite the human description
 * (everything after the ` - `) through the tiny adapter's
 * `normalize-title` task when the adapter is enabled. Returns a
 * new sources block string with descriptions substituted;
 * non-matching lines are preserved verbatim.
 *
 * Errors / disabled adapter / null responses keep the original
 * description. Never fabricates.
 */
export async function normalizeSourceTitles<M>(opts: NormalizeSourceTitlesOpts<M>): Promise<string> {
  const adapter = opts.adapter;
  const ctx = opts.ctx;
  const body = opts.sections.sources;
  if (!adapter || !ctx || !adapter.isEnabled()) return body;

  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = SOURCE_LINE_RE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, label, url, desc] = m;
    if (!desc || desc.length === 0) {
      out.push(line);
      continue;
    }
    let rewritten: string | null = null;
    try {
      rewritten = await adapter.callTinyRewrite(ctx, 'normalize-title', desc);
    } catch {
      rewritten = null;
    }
    const finalDesc = rewritten && rewritten.trim().length > 0 ? rewritten.trim() : desc;
    out.push(`- [${label}] ${url} - ${finalDesc}`);
  }
  return out.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// File writer.
// ──────────────────────────────────────────────────────────────────────

/**
 * Atomically write `body` to `path`. Tiny wrapper so callers don't
 * have to import `atomic-write` separately alongside this module.
 */
export function writeFindingFile(path: string, body: string): void {
  atomicWriteFile(path, body.endsWith('\n') ? body : body + '\n');
}

/**
 * True when `path` already exists - used by the extension to skip
 * re-validation work on a resume where the finding already landed
 * and was accepted.
 */
export function findingExists(path: string): boolean {
  return existsSync(path);
}
