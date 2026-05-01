/**
 * Critic-kind check executor helpers for the iteration-loop.
 *
 * This module does NOT spawn the subagent itself — that's the
 * extension's job (it owns the pi runtime handle). Instead we export
 * two pure pieces:
 *
 *   1. `buildCriticTask(spec, artifactPath)` — construct the `task`
 *      string handed to the critic subagent, including the rubric,
 *      the artifact path, and the strict JSON output contract.
 *
 *   2. `parseVerdict(raw)` — tolerant parser that extracts a Verdict
 *      object from the critic's final message. Handles:
 *      - Leading/trailing prose (extract first/last `{...}`).
 *      - Markdown code fences (```json ... ```).
 *      - Minor structural drift: missing `issues` array, score out of
 *        range, severity values we don't recognize.
 *      - Total parse failures (returns a synthetic "failed to parse"
 *        Verdict rather than throwing, so the loop can still record
 *        the iteration and move on).
 *
 * The critic task template is deliberately terse and imperative —
 * weak-model critics produce better structured output when the
 * contract is blunt and leaves no room for preamble.
 *
 * No pi imports.
 */

import { type CriticCheckSpec, type Issue, type IssueSeverity, type Verdict } from './iteration-loop-schema.ts';

// ──────────────────────────────────────────────────────────────────────
// Task template
// ──────────────────────────────────────────────────────────────────────

export interface BuildCriticTaskInput {
  spec: CriticCheckSpec;
  /** Absolute or cwd-relative path the critic should `read`. */
  artifactPath: string;
  /** Iteration number for context. 1-indexed. */
  iteration: number;
}

/**
 * Render the `task` string handed to the critic subagent. The critic
 * agent's body teaches it the contract; this template repeats the
 * important bits so the critic doesn't have to hold two layers of
 * instruction in its head.
 */
export function buildCriticTask(input: BuildCriticTaskInput): string {
  const { spec, artifactPath, iteration } = input;
  const lines: string[] = [];
  lines.push(`You are judging iteration ${iteration} of an artifact against a rubric.`);
  lines.push('');
  lines.push(`Artifact path: ${artifactPath}`);
  lines.push('');
  lines.push('Rubric:');
  for (const line of spec.rubric.split('\n')) lines.push(`  ${line}`);
  lines.push('');
  lines.push('Steps:');
  lines.push('  1. Read the artifact with the `read` tool. Pi auto-attaches images');
  lines.push('     (.png/.jpg/.gif/.webp) so visual artifacts render for you.');
  lines.push('  2. Judge it against EVERY rubric item. Do not invent additional criteria.');
  lines.push('  3. Return JSON only. No prose before, no prose after, no markdown fences.');
  lines.push('');
  lines.push('Output schema (return exactly this shape):');
  lines.push('  {');
  lines.push('    "approved": boolean,              // true iff EVERY rubric item satisfied');
  lines.push('    "score": number,                  // 0..1, your overall rubric-satisfaction');
  lines.push('    "issues": [                       // empty when approved');
  lines.push('      {');
  lines.push('        "severity": "blocker" | "major" | "minor",');
  lines.push('        "description": string,        // specific, actionable');
  lines.push('        "location": string            // optional: line/element/region');
  lines.push('      }');
  lines.push('    ],');
  lines.push('    "summary": string                 // one-line overall summary');
  lines.push('  }');
  lines.push('');
  lines.push('Rules:');
  lines.push('  - `approved: true` requires ALL rubric items pass. Partial credit goes in `score`.');
  lines.push('  - Issue descriptions must say WHAT is wrong and WHERE — "label X is missing"');
  lines.push('    beats "labels are off".');
  lines.push('  - Do not include ANYTHING outside the JSON object. No markdown fences.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Verdict parser — public entry point declared after its internals.
// ──────────────────────────────────────────────────────────────────────

export interface ParseVerdictResult {
  verdict: Verdict;
  /**
   * Non-null when parsing required tolerance (prose-leakage, missing
   * field recovery, etc.). The extension can surface this as a debug
   * signal or ignore it.
   */
  recovery: string | null;
  /**
   * True when parsing completely failed and we returned a synthetic
   * failure verdict. Callers may want to log or treat as an error.
   */
  failed: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Parser internals
// ──────────────────────────────────────────────────────────────────────

/** Strip triple-backtick fences (optionally tagged with a language). */
function stripFences(text: string): { text: string; recoveries: string[] } {
  const recoveries: string[] = [];
  // Match a fence at the start and optional closing fence at end. We
  // look for ``` optionally followed by a language tag like `json`.
  const openRe = /^```(?:json|JSON|Json)?\s*\n?/;
  const closeRe = /\n?```\s*$/;
  let out = text;
  if (openRe.test(out)) {
    out = out.replace(openRe, '');
    recoveries.push('stripped opening fence');
  }
  if (closeRe.test(out)) {
    out = out.replace(closeRe, '');
    recoveries.push('stripped closing fence');
  }
  return { text: out.trim(), recoveries };
}

/**
 * Extract the outermost balanced JSON object from `text`. Handles
 * nested braces, string literals (with escapes), and prose surrounding
 * the JSON. Returns null when no balanced `{...}` exists.
 */
function sliceJsonObject(text: string): { json: string | null; recoveries: string[] } {
  const recoveries: string[] = [];
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) return { json: null, recoveries };

  if (firstBrace > 0) recoveries.push(`skipped ${firstBrace} chars of preamble`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const tail = text.length - (i + 1);
        if (tail > 0) recoveries.push(`skipped ${tail} chars of trailing text`);
        return { json: text.slice(firstBrace, i + 1), recoveries };
      }
    }
  }
  // Unbalanced — no matching close.
  return { json: null, recoveries: [...recoveries, 'unbalanced braces'] };
}

const ALLOWED_SEVERITIES: readonly IssueSeverity[] = ['blocker', 'major', 'minor'];

function normalizeSeverity(v: unknown): IssueSeverity {
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    if ((ALLOWED_SEVERITIES as readonly string[]).includes(lower)) return lower as IssueSeverity;
    // Tolerance: map common synonyms.
    if (lower === 'critical' || lower === 'high' || lower === 'fatal') return 'blocker';
    if (lower === 'medium' || lower === 'warning' || lower === 'warn') return 'major';
    if (lower === 'low' || lower === 'info' || lower === 'nit' || lower === 'style') return 'minor';
  }
  return 'major';
}

function normalizeScore(raw: unknown, approved: boolean): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 0) return 0;
    if (raw > 1) return 1;
    return raw;
  }
  return approved ? 1 : 0;
}

function normalizeIssue(v: unknown, _fallbackIdx: number): Issue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const desc = typeof o.description === 'string' ? o.description.trim() : '';
  if (!desc) return null;
  const severity = normalizeSeverity(o.severity);
  const location = typeof o.location === 'string' ? o.location : undefined;
  return {
    severity,
    description: desc,
    location,
  };
}

function synthFailureVerdict(reason: string, raw: string): Verdict {
  return {
    approved: false,
    score: 0,
    issues: [
      {
        severity: 'blocker',
        description: `critic verdict could not be parsed: ${reason}`,
      },
    ],
    summary: `parse failure: ${reason}`,
    raw,
  };
}

function normalizeVerdict(parsed: unknown, raw: string, prior: string[]): ParseVerdictResult {
  const recoveries = [...prior];
  if (!parsed || typeof parsed !== 'object') {
    return {
      verdict: synthFailureVerdict('critic output is not a JSON object', raw),
      recovery: recoveries.join('; ') || null,
      failed: true,
    };
  }
  const o = parsed as Record<string, unknown>;

  // approved — required, but tolerate truthy/falsy coercions.
  let approved: boolean;
  if (typeof o.approved === 'boolean') {
    approved = o.approved;
  } else if (typeof o.approved === 'string') {
    approved = /^(true|yes|pass(ed)?|approved)$/i.test(o.approved.trim());
    recoveries.push(`coerced approved from string "${o.approved}"`);
  } else {
    approved = false;
    recoveries.push('missing/invalid `approved`; defaulted to false');
  }

  // issues — required array, but tolerate missing or wrongly-typed.
  let issuesRaw: unknown[] = [];
  if (Array.isArray(o.issues)) {
    issuesRaw = o.issues;
  } else if (o.issues === undefined) {
    if (!approved) recoveries.push('missing `issues` array; defaulted to empty');
  } else {
    recoveries.push('`issues` is not an array; defaulted to empty');
  }
  const issues: Issue[] = [];
  let droppedIssues = 0;
  for (let i = 0; i < issuesRaw.length; i++) {
    const normalized = normalizeIssue(issuesRaw[i], i);
    if (normalized) issues.push(normalized);
    else droppedIssues++;
  }
  if (droppedIssues > 0) recoveries.push(`dropped ${droppedIssues} malformed issue(s)`);

  // Consistency check: if approved=true but issues are present with
  // severity=blocker, that's incoherent. Downgrade approved.
  if (approved && issues.some((i) => i.severity === 'blocker')) {
    approved = false;
    recoveries.push('approved=true but blocker issues present; forced approved=false');
  }

  const score = normalizeScore(o.score, approved);

  const summary = typeof o.summary === 'string' ? o.summary : undefined;

  const verdict: Verdict = {
    approved,
    score,
    issues,
    summary,
    raw,
  };
  return {
    verdict,
    recovery: recoveries.length ? recoveries.join('; ') : null,
    failed: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Verdict parser — public entry point declared after its internals.
// ──────────────────────────────────────────────────────────────────────

/**
 * Tolerant verdict parser. Given a critic's raw final message,
 * extract a Verdict. Never throws — on total failure, returns a
 * synthetic failure Verdict with the raw text preserved in `raw`.
 */
export function parseVerdict(rawText: string): ParseVerdictResult {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) {
    return {
      verdict: synthFailureVerdict('empty critic response', trimmed),
      recovery: null,
      failed: true,
    };
  }

  const { text: stripped, recoveries: strip_recoveries } = stripFences(trimmed);
  const { json, recoveries: slice_recoveries } = sliceJsonObject(stripped);
  const recoveries = [...strip_recoveries, ...slice_recoveries];

  if (json === null) {
    return {
      verdict: synthFailureVerdict('no JSON object found in critic response', trimmed),
      recovery: recoveries.length ? recoveries.join('; ') : null,
      failed: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      verdict: synthFailureVerdict(`JSON parse error: ${(e as Error).message}`, trimmed),
      recovery: recoveries.length ? recoveries.join('; ') : null,
      failed: true,
    };
  }

  const normalized = normalizeVerdict(parsed, trimmed, recoveries);
  return normalized;
}
