/**
 * Deterministic story-beat extraction for the `roleplay` extension - the
 * ANTI-DRIFT complement to the recap.
 *
 * The recap (`summary/auto`) is CONSOLIDATIVE
 * (`recap_n = summarize(span_n, recap_{n-1})`): each roll re-feeds the prior
 * recap to a model, so it drifts and sheds specifics over time. The timeline
 * is ADDITIVE (`timeline += extract(span_n)`): dated beats are appended once
 * and NEVER re-fed to a model, so a beat's text is byte-stable for the life
 * of the scene. The recap answers "where are we now"; the timeline answers
 * "what happened, in order".
 *
 * This module holds only the pure task-builder + tolerant response parser +
 * formatters; the extension owns the subagent spawn, session-id gating, the
 * append-log write, and injection.
 *
 * No pi imports.
 */

import { extractBalancedArray } from '../json-loose.ts';
import { clampWords } from './text.ts';

/** A single extracted story beat. `when` is an optional in-world time. */
export interface TimelineBeat {
  /** Optional in-world date/time string as stated in the span (e.g. "Thursday 6pm"). */
  when?: string;
  /** One-line description of the event / decision / plan. */
  summary: string;
}

/** Hard cap on beats extracted per roll so a runaway extraction can't flood the log. */
export const MAX_BEATS_PER_ROLL = 6;
/** Char cap on a single beat summary (one-liners only). */
export const MAX_BEAT_CHARS = 160;
/** Char cap on a `when` string. */
export const MAX_WHEN_CHARS = 40;

/**
 * Build the task prompt for the `roleplay-timeline-extractor` agent. The
 * extractor reads ONLY the newly-aged span and returns a JSON array of
 * chronological beats for notable events / decisions / plans, or `[]` when
 * there is nothing notable.
 */
export function buildTimelineExtractionTask(spanText: string): string {
  return (
    'This is a span of a roleplay conversation. Extract the NOTABLE story beats - the events that move the ' +
    'scene forward and would belong on a timeline someone skims later: arrivals and departures, decisions, ' +
    'plans agreed, promises made, state or mode changes, objects changing hands, plot turns. Record only ' +
    'what the span explicitly states; never invent.\n\n' +
    'Keep it a skeleton, not a play-by-play. Collapse a stretch of minor back-and-forth into ONE beat, and ' +
    'SKIP fleeting detail: individual food or drink orders, single lines of banter, small physical actions ' +
    '(a bite, a sip, pouring, wiping), mood, and pure narration or scene description.\n\n' +
    'Return a JSON array (and nothing else) of at most ' +
    `${MAX_BEATS_PER_ROLL} objects, each {"when": "...", "summary": "..."}, in chronological order. ` +
    '"summary" is a single terse line naming the beat (under ' +
    `${MAX_BEAT_CHARS} characters). "when" is the in-world date/time if the span states one ` +
    '(e.g. "Thursday 6pm", "the next morning"); OMIT the "when" key entirely when no time is stated. ' +
    'Do NOT invent times. If the span contains no notable beats, return exactly [].\n\n' +
    `Span:\n${spanText}`
  );
}

/**
 * Parse the extractor's response into validated beats. Tolerant: accepts a
 * bare JSON array, a fenced block, or an array embedded in prose. Drops
 * entries with an empty `summary`, clamps lengths, and caps the count.
 * Returns `[]` on any parse failure or the literal `null` sentinel (never
 * throws). Unlike facts, beats are NOT de-duped here - the append-log is
 * ordered and a genuine repeat beat is rare; de-dup would risk dropping a
 * real recurrence ("returned to the outpost").
 */
export function parseTimelineBeats(raw: string): TimelineBeat[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === 'null' || trimmed === '[]') return [];
  const jsonText = extractBalancedArray(trimmed);
  if (jsonText === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TimelineBeat[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const summary = typeof rec.summary === 'string' ? clampWords(rec.summary, MAX_BEAT_CHARS) : '';
    if (summary.length === 0) continue;
    const whenRaw = typeof rec.when === 'string' ? clampWords(rec.when, MAX_WHEN_CHARS) : '';
    out.push(whenRaw.length > 0 ? { when: whenRaw, summary } : { summary });
    if (out.length >= MAX_BEATS_PER_ROLL) break;
  }
  return out;
}

/** Render one beat as an append-log line: `- [when] summary` or `- summary`. */
export function formatBeatLine(beat: TimelineBeat): string {
  return beat.when ? `- [${beat.when}] ${beat.summary}` : `- ${beat.summary}`;
}

/** Render a set of beats as append-log lines (chronological, one per line). */
export function formatBeatLines(beats: readonly TimelineBeat[]): string {
  return beats.map(formatBeatLine).join('\n');
}

/**
 * Parse an append-log body (as written by {@link formatBeatLines}) back into
 * lines, dropping blanks. Tolerant of hand edits: any non-empty trimmed line
 * is kept verbatim.
 */
export function parseBeatLog(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/**
 * Normalize a beat line for append-time dedup comparison: trim, collapse
 * internal whitespace, lowercase. Two beats that normalize equal are
 * byte-identical modulo whitespace/case and are folded on append; distinct
 * wording of a genuine recurrence still survives.
 */
export function normalizeBeatLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Return the beats parsed from `candidateBody` that are NOT already present
 * in `existingBody`, de-duped within the batch too, joined by newline.
 * Comparison is on the {@link normalizeBeatLine} form. This is the pure
 * de-dup used when appending a fresh roll's beats onto an append-log (the
 * disk carry-over or the in-memory injected timeline).
 */
export function dedupeNewBeats(candidateBody: string, existingBody: string): string {
  const seen = new Set(parseBeatLog(existingBody).map(normalizeBeatLine));
  const kept: string[] = [];
  for (const l of parseBeatLog(candidateBody)) {
    const k = normalizeBeatLine(l);
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    kept.push(l);
  }
  return kept.join('\n');
}

/** Append `add` onto an `existing` beat-log body, inserting a separating newline only when `existing` is non-blank. */
export function appendBeatBody(existing: string, add: string): string {
  return existing.trim() ? `${existing.trimEnd()}\n${add}` : add;
}

export interface RenderTimelineOpts {
  /** Keep only the most-recent K lines (chronological order preserved). Default: all. */
  maxLines?: number;
  /** Soft cap on the rendered block, in characters. Default 1200. */
  maxChars?: number;
}

const DEFAULT_TIMELINE_MAX_CHARS = 1200;

/**
 * Render a compact injected timeline block from an append-log body. Keeps the
 * most-recent `maxLines` lines (in chronological order), then trims from the
 * FRONT (oldest) to fit `maxChars`. Returns `null` when there is nothing to
 * show. The heading is the caller's concern; this returns only the body.
 */
export function renderTimelineBlock(body: string, opts: RenderTimelineOpts = {}): string | null {
  const maxChars = opts.maxChars ?? DEFAULT_TIMELINE_MAX_CHARS;
  let lines = parseBeatLog(body);
  if (lines.length === 0) return null;
  if (typeof opts.maxLines === 'number' && opts.maxLines > 0 && lines.length > opts.maxLines) {
    lines = lines.slice(lines.length - opts.maxLines);
  }
  // Trim oldest lines until the joined block fits the char cap.
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines = lines.slice(1);
  }
  const joined = lines.join('\n');
  if (joined.trim().length === 0) return null;
  // At this point the block either fits or has collapsed to a single line
  // that still overflows; clamp that lone line on a word boundary rather
  // than slicing mid-word.
  return joined.length > maxChars ? clampWords(joined, maxChars) : joined;
}
