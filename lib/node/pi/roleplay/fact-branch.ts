/**
 * Branch scoping for roleplay-captured facts.
 *
 * Captured facts live in `memory`'s SESSION note tier, which is shared by
 * every branch of a session file. Each capture records the notes it wrote in
 * its `roleplay-capture` branch entry, so after `/tree`, a fork, or a resume
 * the extension can make the note tier match the ACTIVE branch: remove notes
 * that only other branches captured and restore the ones this branch did.
 *
 * Only notes named by some capture entry are ever planned for removal;
 * untagged or legacy notes (captured before entries recorded their facts)
 * are left alone. No pi imports.
 */

import { isRecord } from '../shared/guards.ts';
import { isSceneBoundary } from './scene-state.ts';

export const CAPTURE_ENTRY_TYPE = 'roleplay-capture';

export interface CapturedFact {
  slug: string;
  name: string;
  description: string;
}

/** Facts one `roleplay-capture` entry wrote for `cast`, or none. */
function entryFacts(entry: Record<string, unknown>, cast: string): CapturedFact[] {
  if (entry.type !== 'custom' || entry.customType !== CAPTURE_ENTRY_TYPE || !isRecord(entry.data)) return [];
  if (entry.data.cast !== cast || !Array.isArray(entry.data.facts)) return [];
  return entry.data.facts.flatMap((fact: unknown) =>
    isRecord(fact) &&
    typeof fact.slug === 'string' &&
    fact.slug.length > 0 &&
    typeof fact.name === 'string' &&
    typeof fact.description === 'string'
      ? [{ slug: fact.slug, name: fact.name, description: fact.description }]
      : [],
  );
}

export interface FactReconcilePlan {
  /** Note slugs some capture wrote that the active branch's current scene did not. */
  remove: Set<string>;
  /** Facts the active branch's current scene captured, oldest first, deduped by slug. */
  keep: CapturedFact[];
}

/**
 * Plan the note tier for the active branch. `allEntries` is every session
 * entry (all branches); `branch` is the active root-to-leaf path. Only
 * captures after the branch's latest scene boundary count as kept: a
 * newscene or cast change already cleared earlier notes.
 */
export function planFactReconcile(
  allEntries: readonly Record<string, unknown>[],
  branch: readonly Record<string, unknown>[],
  cast: string,
): FactReconcilePlan {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (isSceneBoundary(branch[i])) {
      start = i + 1;
      break;
    }
  }
  const keep = new Map<string, CapturedFact>();
  for (const entry of branch.slice(start)) for (const fact of entryFacts(entry, cast)) keep.set(fact.slug, fact);
  const remove = new Set<string>();
  for (const entry of allEntries)
    for (const fact of entryFacts(entry, cast)) if (!keep.has(fact.slug)) remove.add(fact.slug);
  return { remove, keep: [...keep.values()] };
}
