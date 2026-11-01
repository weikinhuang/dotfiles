import { atomicWriteFile } from '../atomic-write.ts';
import { fileFor, indexFileFor, readTextFile, rebuildMemoryIndex, removeFileIfExists } from '../memory-paths.ts';
import { renderMemoryMd, serializeMemory } from '../memory-reducer.ts';
import { parseFencedFrontmatter } from '../shared/strict-frontmatter.ts';

/** Ownership stays outside memory's public schema; unknown frontmatter is already supported there. */
export function serializeRoleplayFact(input: {
  cast: string;
  name: string;
  description: string;
  body: string;
  created: string;
  updated: string;
}): string {
  const serialized = serializeMemory({ ...input, type: 'note' });
  return serialized.replace(/^---\n/, `---\nroleplayFactCast: ${JSON.stringify(input.cast)}\n`);
}

/** Remove only notes this extension wrote for this cast, never untagged legacy/user notes. */
export function clearRoleplayFacts(cwd: string, sessionId: string | null, cast: string): number {
  if (!sessionId || !cast) return 0;
  let removed = 0;
  try {
    const { state } = rebuildMemoryIndex(cwd, sessionId);
    for (const entry of state.index.session) {
      if (entry.type !== 'note') continue;
      const path = fileFor('session', 'note', entry.id, cwd, sessionId);
      const raw = readTextFile(path);
      if (raw === null || parseFencedFrontmatter(raw)?.fields.roleplayFactCast !== cast) continue;
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
