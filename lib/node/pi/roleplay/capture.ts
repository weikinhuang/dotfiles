/**
 * Deterministic fact capture for the `roleplay` extension.
 *
 * Pure, pi-free helpers for the capture path that runs on the rolling
 * window's roll. Because roleplay suppresses pi's threshold auto-compaction
 * (see `context-window.ts`), the `memory` extension's capture-assist no
 * longer fires on the common path, so roleplay captures durable facts
 * itself - deterministically, not by nudging the model to call a tool
 * (small-model tool-firing for saves is unreliable; `memory.md` records 0
 * saves across many small-model trials without a follow-up turn).
 *
 * The recap (`summary/auto`) is a thin, lossy narrative layer; durable facts
 * belong in a pinned store. This path routes extracted facts to `memory`'s
 * SESSION (`note`) tier so they survive resume, die on a fresh scene, and
 * show in `/memory`. gemma will not `memory read` a body and the session
 * tier injects only name + description, so each fact must be
 * SELF-CONTAINED in `name` + `description` (`name: "User allergic to
 * shellfish"`), never buried in a body.
 *
 * This module holds only the pure task-builder + tolerant response parser;
 * the extension owns the subagent spawn, session-id gating, de-dup, and the
 * memory-tier write.
 *
 * No pi imports.
 */

import { extractBalancedArray } from '../json-loose.ts';
import { clampWords } from './text.ts';

/** A single extracted durable fact, header-carried (payload in name + description). */
export interface FactCandidate {
  name: string;
  description: string;
}

/** Header-carried caps: the tier injects only name + description, so keep them tight. */
export const MAX_FACT_NAME_CHARS = 90;
export const MAX_FACT_DESC_CHARS = 200;
/** Hard cap on facts written per roll so a runaway extraction can't flood the tier. */
export const MAX_FACTS_PER_ROLL = 6;

/**
 * Default EDITABLE guidance for fact extraction: what makes a fact durable
 * and worth pinning, and what to exclude. A downstream project can replace
 * this via a `prompts/facts.md` override (see `prompt-override.ts`); the
 * fixed JSON object shape, `[]` sentinel, and `MAX_*` caps below are NOT
 * overridable, so `parseFactCandidates` stays safe.
 */
export const DEFAULT_FACTS_GUIDANCE = `You are reading a span of a roleplay conversation that is scrolling out of view. Extract only DURABLE facts worth pinning so they survive after this span is gone. Extract only what the span explicitly states - never infer, guess, or invent; if a detail is ambiguous, leave it out.

A fact is durable ONLY if it would still be true and worth knowing in a LATER, SEPARATE scene. Test every candidate: "Would a participant still need this next week?" If it is just what is happening right now, drop it.

INCLUDE (durable): established names and the recurring title or name characters consistently use for each other; relationships; where someone lives or is based; lasting traits, roles, or possessions and their locations; allergies or health constraints; a scheduled future commitment or standing promise (with any stated time).
EXCLUDE (fleeting - these live in the running recap, never here): what someone ate, ordered, or drank; what a character is doing, wearing, or feeling right now; momentary positions or mood; a one-off tease or pet name used in the moment; the weather; travel or actions in progress; and anything the current scene is simply narrating.`;

/**
 * Build the task prompt for the `roleplay-fact-extractor` agent. The
 * extractor reads ONLY the newly-aged span (never the recap or the
 * accumulated store) and returns a JSON array of durable, self-contained
 * facts, or `[]` when there is nothing worth pinning.
 *
 * `guidance` overrides {@link DEFAULT_FACTS_GUIDANCE} (what to include /
 * exclude) when a non-empty string is supplied; the output contract (JSON
 * object shape, `[]` sentinel, `MAX_*` caps) and the span itself are
 * always builder-owned, so an override can never break the parser.
 */
export function buildFactExtractionTask(spanText: string, guidance?: string): string {
  const g = guidance && guidance.trim().length > 0 ? guidance.trim() : DEFAULT_FACTS_GUIDANCE;
  const contract =
    'For each fact return an object {"name": "...", "description": "..."}:\n' +
    '- "name": ONE short, self-contained claim (subject + what is true), e.g. "User is allergic to ' +
    `shellfish". Keep it brief (under ${MAX_FACT_NAME_CHARS} characters); do NOT cram a list of ` +
    'specifics into it.\n' +
    '- "description": the concrete specifics or qualifiers that complete the fact, plus any stated time, ' +
    `under ${MAX_FACT_DESC_CHARS} characters. State the fact itself - do NOT describe where or how it ` +
    'was mentioned in the text.\n\n' +
    `Return ONLY a JSON array of at most ${MAX_FACTS_PER_ROLL} such objects, and nothing else. If the ` +
    'span has no durable facts, return exactly [].';
  return `${g}\n\n${contract}\n\nSpan:\n${spanText}`;
}

/**
 * Parse the extractor's response into validated fact candidates. Tolerant:
 * accepts a bare JSON array, a ```json fenced block, or an array embedded in
 * prose. Drops non-object / empty entries, clamps lengths, de-dups by
 * lowercased name, and caps the count. Returns `[]` on any parse failure or
 * the literal `null` sentinel (never throws).
 */
export function parseFactCandidates(raw: string): FactCandidate[] {
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
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? clampWords(rec.name, MAX_FACT_NAME_CHARS) : '';
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const rawDesc = typeof rec.description === 'string' ? rec.description : '';
    const description = clampWords(rawDesc.length > 0 ? rawDesc : name, MAX_FACT_DESC_CHARS);
    seen.add(key);
    out.push({ name, description });
    if (out.length >= MAX_FACTS_PER_ROLL) break;
  }
  return out;
}
