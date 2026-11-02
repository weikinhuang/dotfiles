import { atomicWriteFile } from '../atomic-write.ts';
import { fileFor, indexFileFor, readTextFile, rebuildMemoryIndex, removeFileIfExists } from '../memory-paths.ts';
import { renderMemoryMd, serializeMemory } from '../memory-reducer.ts';
import { parseFencedFrontmatter } from '../shared/strict-frontmatter.ts';

/** Frontmatter key tagging a session note as a roleplay-captured fact for one cast. */
export const ROLEPLAY_FACT_CAST_KEY = 'roleplayFactCast';

/**
 * Serialize a captured fact as an ordinary memory `note` plus a
 * {@link ROLEPLAY_FACT_CAST_KEY} ownership tag. The tag stays outside
 * memory's schema: memory carries unknown frontmatter keys on
 * `Frontmatter.extra` and re-emits them on `update`, so an edited fact keeps
 * its owner and is still cleared by {@link clearRoleplayFacts}.
 */
export function serializeRoleplayFact(input: {
  cast: string;
  name: string;
  description: string;
  body: string;
  created: string;
  updated: string;
}): string {
  const { cast, ...rest } = input;
  return serializeMemory({ ...rest, type: 'note', extra: { [ROLEPLAY_FACT_CAST_KEY]: cast } });
}

/**
 * Remove only notes this extension wrote for this cast, never untagged
 * legacy/user notes. `only` narrows removal to those note ids (branch
 * reconciliation after `/tree`); otherwise every owned note goes.
 */
export function clearRoleplayFacts(
  cwd: string,
  sessionId: string | null,
  cast: string,
  opts: { only?: ReadonlySet<string> } = {},
): number {
  if (!sessionId || !cast) return 0;
  let removed = 0;
  try {
    const { state } = rebuildMemoryIndex(cwd, sessionId);
    for (const entry of state.index.session) {
      if (entry.type !== 'note') continue;
      if (opts.only && !opts.only.has(entry.id)) continue;
      const path = fileFor('session', 'note', entry.id, cwd, sessionId);
      const raw = readTextFile(path);
      if (raw === null || parseFencedFrontmatter(raw)?.fields[ROLEPLAY_FACT_CAST_KEY] !== cast) continue;
      try {
        if (removeFileIfExists(path)) removed += 1;
      } catch {
        // One unwritable note must not block cleanup of the others.
      }
    }
    if (removed > 0) {
      const { state: refreshed } = rebuildMemoryIndex(cwd, sessionId);
      atomicWriteFile(indexFileFor('session', cwd, sessionId), renderMemoryMd(refreshed.index.session, 'session'));
    }
  } catch {
    // Scene reset must still invalidate in-memory work after an I/O failure.
  }
  return removed;
}
