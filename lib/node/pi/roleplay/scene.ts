/**
 * Phase 5 - scene composition.
 *
 * Folds the full body sheets of the active scene's characters into the
 * system prompt (above the lightweight cast index), plus a player-POV
 * line. Unlike the cast index (one line per entry, bodies fetched on
 * demand via `roleplay read`), the scene block puts whole character
 * sheets in front of the model so it can roleplay them immediately - the
 * SillyTavern "character card is always in context" behaviour.
 *
 * Selection is persona-driven (`characters: [...]`, `pov: <name>`
 * frontmatter). Pure: disk reads are injected via a `bodyOf` callback so
 * this module stays vitest-testable without the pi runtime.
 */

import { slugifyName, type RoleplayEntry, type RoleplayState } from './store.ts';

const HEADER = '## Roleplay scene';

export interface SceneOptions {
  /** Character names / ids whose full bodies fold into the prompt, in order. */
  characters?: readonly string[];
  /** The character the human plays. Folded last + announced; may be off-cast. */
  pov?: string;
  /** Soft char cap on the rendered block. Floor 500. */
  maxChars?: number;
}

export interface SceneResult {
  /** The rendered block, or `null` when nothing to fold. */
  block: string | null;
  /** Declared `characters` names that did not resolve to a cast character. */
  missing: string[];
}

/**
 * Resolve one declared name to a `character`-kind entry: exact id, then
 * case-insensitive name, then case-insensitive name-slug. Returns
 * `undefined` when nothing matches.
 */
export function resolveCharacter(state: RoleplayState, name: string): RoleplayEntry | undefined {
  const needle = name.trim();
  if (needle.length === 0) return undefined;
  const chars = state.entries.filter((e) => e.kind === 'character');
  const byId = chars.find((e) => e.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = chars.find((e) => e.name.toLowerCase() === lower);
  if (byName) return byName;
  const slug = slugifyName(needle);
  return chars.find((e) => e.id === slug);
}

interface SceneSection {
  heading: string;
  body: string;
}

/**
 * Fold the selected character sheets + POV line into a `## Roleplay
 * scene` block. Returns `{ block: null }` when neither `characters` nor a
 * resolvable `pov` is supplied (callers keep the index-only behaviour).
 *
 * Ordering: declared `characters` (in listed order, deduped), then the
 * POV character last tagged `(player character)`. A character listed both
 * in `characters` and as `pov` renders once, tagged as the player.
 *
 * Callers supply `characters` in **precedence order** (highest first);
 * the roleplay shell passes persona-declared + `pinned` + name-triggered
 * folds in that order. Budget eviction respects that precedence:
 *   - the **POV sheet is never evicted** (highest precedence, `pov` >
 *     `pinned` > name-triggered) - its cost is reserved before any NPC,
 *   - NPC sheets are kept greedily in the given order, so the lowest-
 *     precedence (name-triggered, listed last) are dropped first,
 *   - when there is no POV sheet the first NPC is always kept, so a
 *     too-small budget can never blank the whole block.
 * Omitted NPC sheets are reported via a trailer.
 */
export function composeSceneBlock(
  state: RoleplayState,
  bodyOf: (entry: RoleplayEntry) => string,
  opts: SceneOptions = {},
): SceneResult {
  const missing: string[] = [];
  const seen = new Set<string>();
  const folds: RoleplayEntry[] = [];

  for (const raw of opts.characters ?? []) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const entry = resolveCharacter(state, name);
    if (!entry) {
      missing.push(name);
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    folds.push(entry);
  }

  const povName = opts.pov?.trim() ?? '';
  const povEntry = povName.length > 0 ? resolveCharacter(state, povName) : undefined;
  // The POV character renders last + tagged; drop it from the NPC list.
  const npcs = povEntry ? folds.filter((e) => e.id !== povEntry.id) : folds;

  if (npcs.length === 0 && !povEntry && povName.length === 0) {
    return { block: null, missing };
  }

  const npcSections: SceneSection[] = [];
  for (const entry of npcs) {
    const body = bodyOf(entry).trim();
    if (body.length === 0) continue;
    npcSections.push({ heading: `### ${entry.name}`, body });
  }
  let povSection: SceneSection | null = null;
  if (povEntry) {
    const body = bodyOf(povEntry).trim();
    if (body.length > 0) povSection = { heading: `### ${povEntry.name} (player character)`, body };
  }

  const lines: string[] = [HEADER, ''];
  if (povName.length > 0) {
    lines.push(`The user plays **${povEntry ? povEntry.name : povName}**.`, '');
  }
  if (npcSections.length === 0 && !povSection) {
    // POV-only with no foldable body: still announce the POV line.
    if (lines.length <= 2) return { block: null, missing };
    return { block: lines.join('\n').trimEnd(), missing };
  }

  const cap = Math.max(500, opts.maxChars ?? 3000);
  let used = lines.join('\n').length;
  // Reserve the POV sheet's cost first: it is the highest-precedence fold
  // (pov > pinned > name-triggered) and is never evicted.
  const renderCost = (s: SceneSection): number => `${s.heading}\n${s.body}`.length + 2;
  if (povSection) used += renderCost(povSection);
  let omitted = 0;
  for (const [i, section] of npcSections.entries()) {
    const rendered = `${section.heading}\n${section.body}`;
    // With no POV sheet, always keep the first NPC even if it alone exceeds
    // the cap, so the block is never blanked. Otherwise drop overflow (the
    // lowest-precedence, listed-last NPCs go first).
    const guaranteed = i === 0 && !povSection;
    if (!guaranteed && used + rendered.length + 2 > cap) {
      omitted++;
      continue;
    }
    lines.push(rendered, '');
    used += rendered.length + 2;
  }
  if (povSection) lines.push(`${povSection.heading}\n${povSection.body}`, '');

  if (omitted > 0) {
    lines.push(`(${omitted} character sheet(s) omitted for length - raise \`charBudget\` to include them.)`);
  }

  return { block: lines.join('\n').trimEnd(), missing };
}
