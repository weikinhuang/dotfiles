/**
 * The `memory` tool actions (list / read / save / update / remove / search)
 * over the on-disk store, shared by the pi `memory` extension and the
 * opencode `memory` plugin so both hosts write byte-identical files and
 * `MEMORY.md` indices.
 *
 * Each action takes the freshly rescanned {@link MemoryState} and returns
 * the tool text plus the post-action state. Writes go straight to disk via
 * memory-paths (exclusive-create slug claims, atomic writes, index rewrite
 * from the scanned state). Host bookkeeping (delivery baselines, capture
 * gating, UI rendering) stays in the caller, driven by `change`.
 *
 * No pi imports.
 */

import {
  atomicWriteFile,
  chooseMemorySlug,
  fileFor,
  indexFileFor,
  readMemoryBody,
  readMemoryFrontmatter,
  removeFileIfExists,
  reserveMemoryFile,
  slugifyName,
} from '../memory-paths.ts';
import {
  formatText,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
  removeEntry,
  renderMemoryMd,
  resolveMemoryEntry,
  serializeMemory,
  upsertEntry,
} from '../memory-reducer.ts';
import { findSimilarMemories, searchMemories } from '../memory-search.ts';
import { validateSaveParams } from './save.ts';

export const MEMORY_ACTIONS = ['list', 'read', 'save', 'update', 'remove', 'search'] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

/** The `memory` tool parameters (both hosts validate into this shape). */
export interface MemoryActionParams {
  action: MemoryAction;
  type?: MemoryType;
  scope?: MemoryScope;
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  query?: string;
}

/** Where and how an action touches the store. */
export interface MemoryActionIo {
  cwd: string;
  /** Current session id; `null` disables the session scope. */
  sessionId: string | null;
  /** Memory root (`memoryRoot()` for pi). */
  root: string;
  now: () => Date;
  /** When set, writes fail with `memory is read-only: <reason>`. */
  readOnlyReason?: string;
}

/** A write the host may need to account for (delivery baseline, capture gate). */
export type MemoryChange =
  | { kind: 'upsert'; entry: MemoryEntry; replaced?: MemoryEntry }
  | { kind: 'remove'; entry: MemoryEntry };

export interface MemoryActionResult {
  /** Tool text; error results start with `Error: `. */
  content: string;
  isError?: boolean;
  /** Short reason for an error result. */
  error?: string;
  /** Post-action state. */
  state: MemoryState;
  entry?: MemoryEntry;
  matches?: MemoryEntry[];
  body?: string;
  change?: MemoryChange;
}

function bucketFor(index: MemoryIndex, scope: MemoryScope): MemoryEntry[] {
  if (scope === 'global') return index.global;
  if (scope === 'session') return index.session;
  return index.project;
}

function allEntries(index: MemoryIndex): MemoryEntry[] {
  return [...index.global, ...index.project, ...index.session];
}

function writeIndex(scope: MemoryScope, io: MemoryActionIo, index: MemoryIndex): void {
  const md = renderMemoryMd(
    bucketFor(index, scope).filter((e) => e.scope === scope),
    scope,
  );
  atomicWriteFile(indexFileFor(scope, io.cwd, io.sessionId, io.root), md);
}

const withIndex = (state: MemoryState, index: MemoryIndex): MemoryState => ({
  index,
  projectSlug: state.projectSlug,
  sessionId: state.sessionId,
});

const fail = (state: MemoryState, error: string, content = `Error: ${error}`): MemoryActionResult => ({
  content,
  isError: true,
  error,
  state,
});

function bodyOf(entry: MemoryEntry, io: MemoryActionIo): string | null {
  return readMemoryBody(entry, io.cwd, io.sessionId, io.root);
}

function actList(state: MemoryState): MemoryActionResult {
  return { content: formatText(state), state };
}

function actRead(state: MemoryState, params: MemoryActionParams, io: MemoryActionIo): MemoryActionResult {
  const resolved = resolveMemoryEntry(state, params);
  if ('error' in resolved) return fail(state, resolved.error);
  const body = bodyOf(resolved, io);
  if (body == null) return fail(state, `memory "${resolved.id}" not readable on disk`);
  const header = `[${resolved.scope}/${resolved.type}] ${resolved.id} - ${resolved.name}\n${resolved.description}\n`;
  return { content: `${header}\n${body.trim()}\n`, state, entry: { ...resolved }, body };
}

function actSave(state: MemoryState, params: MemoryActionParams, io: MemoryActionIo): MemoryActionResult {
  const validated = validateSaveParams(params, io.sessionId);
  if (!validated.ok) return fail(state, validated.error, validated.content);
  const { type, scope, name, description, body } = validated;
  // Non-blocking duplicate check, scoped to the same scope+type.
  const similar = findSimilarMemories(
    { name, description, body },
    bucketFor(state.index, scope).filter((e) => e.type === type),
    (e) => bodyOf(e, io),
  );
  const warnings: string[] = [];
  if (similar.length > 0) {
    const ids = similar.map((s) => `\`${s.entry.id}\` ([${s.entry.type}])`).join(', ');
    warnings.push(
      `Note: this looks similar to existing memory ${ids}. Consider \`update\`-ing instead of saving a duplicate.`,
    );
  }
  // Claim the file with an exclusive create while picking the slug, so a
  // concurrent save in another session (or host) can never pick the same file.
  const slug = chooseMemorySlug(
    state,
    scope,
    name,
    undefined,
    (s) => !reserveMemoryFile(fileFor(scope, type, s, io.cwd, io.sessionId, io.root)),
  );
  const path = fileFor(scope, type, slug, io.cwd, io.sessionId, io.root);
  // New memory: stamp both timestamps with the same instant.
  const stamp = io.now().toISOString();
  const serialized = serializeMemory({ name, description, type, body, created: stamp, updated: stamp });
  try {
    atomicWriteFile(path, serialized);
  } catch (error) {
    // Drop the empty placeholder so it doesn't surface as a malformed file.
    removeFileIfExists(path);
    throw error;
  }
  const entry: MemoryEntry = { id: slug, scope, type, name, description, created: stamp, updated: stamp };
  const nextIndex = upsertEntry(state.index, entry);
  writeIndex(scope, io, nextIndex);
  const prefix = warnings.length > 0 ? `${warnings.join('\n')}\n\n` : '';
  return {
    content: `${prefix}Saved memory [${scope}/${type}] \`${slug}\` - ${entry.description}`,
    state: withIndex(state, nextIndex),
    entry,
    change: { kind: 'upsert', entry },
  };
}

function actUpdate(state: MemoryState, params: MemoryActionParams, io: MemoryActionIo): MemoryActionResult {
  const resolved = resolveMemoryEntry(state, params);
  if ('error' in resolved) return fail(state, resolved.error);
  if (params.name === undefined && params.description === undefined && params.body === undefined) {
    return fail(state, '`update` requires at least one of `name`, `description`, `body`');
  }
  const nextName = params.name !== undefined ? params.name.trim() : resolved.name;
  if (nextName.length === 0) return fail(state, '`name` may not be empty');
  const nextDescription = params.description !== undefined ? params.description.trim() : resolved.description;
  // When the caller omits `body`, preserve the on-disk body. If it can't be
  // read, refuse to clobber - an empty rewrite would silently destroy content.
  let nextBody: string;
  if (params.body !== undefined) {
    nextBody = params.body.trim();
    if (nextBody.length === 0) return fail(state, '`body` may not be empty - use `remove` to delete the memory');
  } else {
    const existing = bodyOf(resolved, io);
    if (existing === null) {
      return fail(
        state,
        `cannot preserve body: "${resolved.id}" is not readable on disk - pass \`body\` explicitly or re-save`,
      );
    }
    nextBody = existing.trim();
    if (nextBody.length === 0)
      return fail(state, `existing body for "${resolved.id}" is empty - pass \`body\` explicitly`);
  }
  const renamed = params.name !== undefined && slugifyName(params.name) !== resolved.id;
  let nextIndex = state.index;
  let nextId = resolved.id;
  if (renamed && params.name !== undefined) {
    // Drop the outgoing entry BEFORE picking a new slug so a rename that
    // collapses back to the same slug isn't pushed to `-2`. The old file is
    // deleted only after the new one is written.
    nextIndex = removeEntry(nextIndex, resolved.scope, resolved.id, resolved.type);
    nextId = chooseMemorySlug(
      withIndex(state, nextIndex),
      resolved.scope,
      params.name,
      undefined,
      // Our own file is free to keep; any other slug must be claimed.
      (s) =>
        s !== resolved.id &&
        !reserveMemoryFile(fileFor(resolved.scope, resolved.type, s, io.cwd, io.sessionId, io.root)),
    );
  }
  // Preserve `created` (falling back to the on-disk frontmatter for entries
  // indexed before timestamps existed), bump `updated`, and carry unknown
  // frontmatter keys so an edit never drops another extension's metadata.
  const priorFrontmatter = readMemoryFrontmatter(resolved, io.cwd, io.sessionId, io.root);
  const priorCreated = resolved.created ?? priorFrontmatter?.created;
  const updatedStamp = io.now().toISOString();
  const serialized = serializeMemory({
    name: nextName,
    description: nextDescription,
    type: resolved.type,
    body: nextBody,
    created: priorCreated,
    updated: updatedStamp,
    ...(priorFrontmatter?.extra ? { extra: priorFrontmatter.extra } : {}),
  });
  const nextPath = fileFor(resolved.scope, resolved.type, nextId, io.cwd, io.sessionId, io.root);
  try {
    atomicWriteFile(nextPath, serialized);
  } catch (error) {
    if (nextId !== resolved.id) removeFileIfExists(nextPath);
    throw error;
  }
  if (nextId !== resolved.id) {
    removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, io.cwd, io.sessionId, io.root));
  }
  const entry: MemoryEntry = {
    id: nextId,
    scope: resolved.scope,
    type: resolved.type,
    name: nextName,
    description: nextDescription,
    created: priorCreated,
    updated: updatedStamp,
  };
  nextIndex = upsertEntry(nextIndex, entry);
  writeIndex(entry.scope, io, nextIndex);
  return {
    content: `Updated memory [${entry.scope}/${entry.type}] \`${entry.id}\` - ${entry.description}`,
    state: withIndex(state, nextIndex),
    entry,
    change: { kind: 'upsert', entry, replaced: resolved },
  };
}

function actRemove(state: MemoryState, params: MemoryActionParams, io: MemoryActionIo): MemoryActionResult {
  if (!params.scope) return fail(state, '`scope` is required for `remove` (global, project, or session)');
  const resolved = resolveMemoryEntry(state, params);
  if ('error' in resolved) return fail(state, resolved.error);
  removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, io.cwd, io.sessionId, io.root));
  const nextIndex = removeEntry(state.index, resolved.scope, resolved.id, resolved.type);
  writeIndex(resolved.scope, io, nextIndex);
  return {
    content: `Removed memory [${resolved.scope}/${resolved.type}] \`${resolved.id}\``,
    state: withIndex(state, nextIndex),
    entry: resolved,
    change: { kind: 'remove', entry: resolved },
  };
}

function actSearch(state: MemoryState, params: MemoryActionParams, io: MemoryActionIo): MemoryActionResult {
  const q = (params.query ?? '').trim();
  if (q.length === 0) return fail(state, '`query` is required for `search`');
  const matches = searchMemories(allEntries(state.index), (e) => bodyOf(e, io), q).map((s) => s.entry);
  if (matches.length === 0) return { content: `No memories match "${q}".`, state, matches: [] };
  const lines = matches.map((e) => `  [${e.scope}/${e.type}] ${e.id} - ${e.name}: ${e.description}`);
  return { content: `Matches for "${q}" (${matches.length}):\n${lines.join('\n')}`, state, matches };
}

const WRITES: ReadonlySet<MemoryAction> = new Set(['save', 'update', 'remove']);

/** Run one `memory` action against `state` (rescanned by the caller just before). */
export function runMemoryAction(
  state: MemoryState,
  params: MemoryActionParams,
  io: MemoryActionIo,
): MemoryActionResult {
  if (io.readOnlyReason !== undefined && WRITES.has(params.action)) {
    return fail(state, `memory is read-only: ${io.readOnlyReason}`);
  }
  switch (params.action) {
    case 'list':
      return actList(state);
    case 'read':
      return actRead(state, params, io);
    case 'save':
      return actSave(state, params, io);
    case 'update':
      return actUpdate(state, params, io);
    case 'remove':
      return actRemove(state, params, io);
    case 'search':
      return actSearch(state, params, io);
  }
}
