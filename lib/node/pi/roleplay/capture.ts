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
 * SELF-CONTAINED in `name` + `description` (`name: "Wei allergic to
 * shellfish"`), never buried in a body.
 *
 * This module holds only the pure task-builder + tolerant response parser;
 * the extension owns the subagent spawn, session-id gating, de-dup, and the
 * memory-tier write.
 *
 * No pi imports.
 */

/** A single extracted durable fact, header-carried (payload in name + description). */
export interface FactCandidate {
  name: string;
  description: string;
}

/** Header-carried caps: the tier injects only name + description, so keep them tight. */
export const MAX_FACT_NAME_CHARS = 80;
export const MAX_FACT_DESC_CHARS = 200;
/** Hard cap on facts written per roll so a runaway extraction can't flood the tier. */
export const MAX_FACTS_PER_ROLL = 6;

/**
 * Build the task prompt for the `roleplay-fact-extractor` agent. The
 * extractor reads ONLY the newly-aged span (never the recap or the
 * accumulated store) and returns a JSON array of durable, self-contained
 * facts, or `[]` when there is nothing worth pinning.
 */
export function buildFactExtractionTask(spanText: string): string {
  return (
    'This is a span of a roleplay conversation. Extract ONLY durable, factual details a participant ' +
    'would still need to remember many turns later: established names and relationships, where someone ' +
    'lives or is, commitments and plans (with any stated time), objects and their specific locations, ' +
    'allergies or health constraints, promises. Do NOT extract fleeting mood, narration, scene ' +
    'description, or anything already obvious - those belong in the running recap, not here.\n\n' +
    'Return a JSON array (and nothing else) of at most ' +
    `${MAX_FACTS_PER_ROLL} objects, each {"name": "...", "description": "..."}. The "name" MUST be a ` +
    'complete, self-contained statement of the fact on its own (e.g. "Wei is allergic to shellfish"), ' +
    'because only the name and description are ever shown - a reader never opens a body. Keep "name" ' +
    `under ${MAX_FACT_NAME_CHARS} characters and "description" under ${MAX_FACT_DESC_CHARS}. ` +
    'If the span contains no durable facts, return exactly [].\n\n' +
    `Span:\n${spanText}`
  );
}

/** Extract the first top-level JSON array substring from a model response (tolerates fences / prose). */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function clamp(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max).trimEnd() : t;
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
  const jsonText = extractJsonArray(trimmed);
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
    const name = typeof rec.name === 'string' ? clamp(rec.name, MAX_FACT_NAME_CHARS) : '';
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const rawDesc = typeof rec.description === 'string' ? rec.description : '';
    const description = clamp(rawDesc.length > 0 ? rawDesc : name, MAX_FACT_DESC_CHARS);
    seen.add(key);
    out.push({ name, description });
    if (out.length >= MAX_FACTS_PER_ROLL) break;
  }
  return out;
}
