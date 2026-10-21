/**
 * Pure decision logic for the `roleplay` tool's mutating actions (`save` /
 * `update` / `remove`) plus `search`. Each planner validates the params,
 * picks the slug (reserved carry-over slugs rejected, renames re-slugged,
 * bundle lore kept in its bundle dir) and returns either an error or a plan:
 * the file writes to perform (in order), then the files to remove, the next
 * in-memory state, and the tool-result text. The extension shell performs
 * the I/O and commits the state; disk reads (`body` preservation, search
 * body hits) come in through an injected `readBody`.
 *
 * Paths resolve through `paths.ts` (honoring `PI_ROLEPLAY_ROOT` at call
 * time, same as the shell). No pi imports.
 */

import type { ImportPlan } from '../card-import/card-to-records.ts';
import { entryFilePath, fileFor } from './paths.ts';
import {
  chooseSlug,
  emptyCharacterMeta,
  emptyLoreMeta,
  emptyRelationshipMeta,
  formatText,
  isReservedSlug,
  lastInteractionError,
  removeEntry,
  resolveEntry,
  type RoleplayEntry,
  type RoleplayKind,
  type RoleplayState,
  serializeEntry,
  type SlugExists,
  slugifyName,
  upsertEntry,
} from './store.ts';
import { buildCharacterMeta, buildLoreMeta, buildRelationshipMeta, type RoleplayToolParams } from './tool-params.ts';

export interface ActionWrite {
  path: string;
  content: string;
}

export type ActionPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Files to write, in order (performed BEFORE any remove). */
      writes: ActionWrite[];
      /** Files to delete after the writes succeed. */
      removes: string[];
      /** Next in-memory state to commit (then persist the index). */
      state: RoleplayState;
      /** The entry saved / updated / removed (for tool details). */
      entry: RoleplayEntry;
      /** Tool-result text. */
      content: string;
    };

/** Reads an entry's stored body, `null` when unreadable. */
export type ReadEntryBody = (entry: RoleplayEntry) => string | null;

/**
 * True when a file already exists at `path` (the shell passes
 * `existsSync`). Lets slug choice dodge files the in-memory state does not
 * know about (malformed, kind mismatch, base hidden by a bundle) instead of
 * overwriting them. Omitted = only in-memory ids are considered.
 */
export type PathExists = (path: string) => boolean;

const fail = (error: string): ActionPlan => ({ ok: false, error });

const reservedError = (kind: RoleplayKind, slug: string): string =>
  `slug "${slug}" is reserved for the ${kind} carry-over record; choose a different \`name\``;

const reservedRecordError = (kind: RoleplayKind, id: string): string =>
  `"${kind}/${id}" is the scene carry-over record, managed by the extension; it cannot be updated or removed via the tool (use \`/roleplay newscene\` to archive it and start fresh)`;

/** Adapt a path predicate to a slug predicate probing `pathOf(slug)`. */
function slugProbe(exists: PathExists | undefined, pathOf: (slug: string) => string): SlugExists | undefined {
  return exists ? (slug): boolean => exists(pathOf(slug)) : undefined;
}

/** `save`: create a new entry (default kind `character`). */
export function planSave(state: RoleplayState, params: RoleplayToolParams, exists?: PathExists): ActionPlan {
  const kind: RoleplayKind = params.kind ?? 'character';
  if (!params.name || params.name.trim().length === 0) return fail('`name` is required for `save`');
  const description = (params.description ?? '').trim();
  if (description.length === 0) return fail('`description` is required for `save` (one-line index hook)');
  const body = (params.body ?? '').trim();
  if (body.length === 0) return fail('`body` is required for `save`');

  const lastInteractionErr = lastInteractionError(params.lastInteraction);
  if (lastInteractionErr) return fail(lastInteractionErr);

  const slug = chooseSlug(
    state.entries,
    params.name,
    undefined,
    slugProbe(exists, (s) => fileFor(state.cast, kind, s)),
  );
  if (isReservedSlug(kind, slug)) return fail(reservedError(kind, slug));
  const lore = kind === 'lore' ? buildLoreMeta(params) : undefined;
  const character = kind === 'character' ? buildCharacterMeta(params) : undefined;
  const relationship = kind === 'relationship' ? buildRelationshipMeta(params) : undefined;
  const name = params.name.trim();
  const write: ActionWrite = {
    path: fileFor(state.cast, kind, slug),
    content: serializeEntry({ name, description, kind, body, lore, character, relationship }),
  };
  const entry: RoleplayEntry = {
    id: slug,
    kind,
    name,
    description,
    ...(lore ? { lore } : {}),
    ...(character ? { character } : {}),
    ...(relationship ? { relationship } : {}),
  };
  const next: RoleplayState = { cast: state.cast, entries: upsertEntry(state.entries, entry) };
  return {
    ok: true,
    writes: [write],
    removes: [],
    state: next,
    entry,
    content: `Saved [${next.cast}/${kind}] ${slug} - ${entry.name}\n\n${formatText(next)}`,
  };
}

/** True when `params` carries any field the resolved entry's kind accepts on its own. */
function kindParamGiven(kind: RoleplayKind, params: RoleplayToolParams): boolean {
  if (kind === 'lore') {
    return (
      params.triggers !== undefined ||
      params.secondaryKeys !== undefined ||
      params.secondaryMode !== undefined ||
      params.constant !== undefined ||
      params.order !== undefined ||
      params.depth !== undefined ||
      params.recurse !== undefined
    );
  }
  if (kind === 'character') {
    return (
      params.aliases !== undefined ||
      params.pinned !== undefined ||
      params.triggers !== undefined ||
      params.order !== undefined
    );
  }
  if (kind === 'relationship') {
    return (
      params.affinity !== undefined ||
      params.trust !== undefined ||
      params.lastInteraction !== undefined ||
      params.openThreads !== undefined
    );
  }
  return false;
}

/**
 * `update`: patch name / description / body and kind-specific metadata. A
 * name whose slug differs renames the file (new written first, old removed
 * after); bundle lore stays in its bundle dir; unknown frontmatter
 * (`extra`) is preserved. An omitted `body` is preserved via `readBody`.
 */
export function planUpdate(
  state: RoleplayState,
  params: RoleplayToolParams,
  readBody: ReadEntryBody,
  exists?: PathExists,
): ActionPlan {
  const resolved = resolveEntry(state, params);
  if ('error' in resolved) return fail(resolved.error);
  if (isReservedSlug(resolved.kind, resolved.id)) return fail(reservedRecordError(resolved.kind, resolved.id));
  if (
    params.name === undefined &&
    params.description === undefined &&
    params.body === undefined &&
    !kindParamGiven(resolved.kind, params)
  ) {
    return fail(
      '`update` requires at least one of `name`, `description`, `body` (or kind-specific fields for a character/lore/relationship entry)',
    );
  }
  const nextName = params.name !== undefined ? params.name.trim() : resolved.name;
  if (nextName.length === 0) return fail('`name` may not be empty');
  const lastInteractionErr = lastInteractionError(params.lastInteraction);
  if (lastInteractionErr) return fail(lastInteractionErr);
  const nextDescription = params.description !== undefined ? params.description.trim() : resolved.description;

  let nextBody: string;
  if (params.body !== undefined) {
    nextBody = params.body.trim();
    if (nextBody.length === 0) return fail('`body` may not be empty - use `remove` to delete the entry');
  } else {
    const existing = readBody(resolved);
    if (existing === null)
      return fail(`cannot preserve body: "${resolved.id}" not readable - pass \`body\` explicitly`);
    nextBody = existing.trim();
    if (nextBody.length === 0) return fail(`existing body for "${resolved.id}" is empty - pass \`body\` explicitly`);
  }

  // Ids are file stems and may be mixed case (`character/Foo.md`) while
  // slugs are lowercase: a case-only difference is NOT a rename (on a
  // case-insensitive FS the "new" and "old" paths are the same file).
  const renamed = params.name !== undefined && slugifyName(params.name) !== resolved.id.toLowerCase();
  let entries = state.entries;
  let nextId = resolved.id;
  if (renamed) {
    entries = removeEntry(entries, resolved.kind, resolved.id);
    nextId = chooseSlug(
      entries,
      params.name!,
      resolved.id,
      slugProbe(exists, (s) => entryFilePath(state.cast, { ...resolved, id: s })),
    );
    if (nextId.toLowerCase() === resolved.id.toLowerCase()) nextId = resolved.id;
    if (isReservedSlug(resolved.kind, nextId)) return fail(reservedError(resolved.kind, nextId));
  }
  const lore = resolved.kind === 'lore' ? buildLoreMeta(params, resolved.lore ?? emptyLoreMeta()) : undefined;
  const character =
    resolved.kind === 'character' ? buildCharacterMeta(params, resolved.character ?? emptyCharacterMeta()) : undefined;
  const relationship =
    resolved.kind === 'relationship'
      ? buildRelationshipMeta(params, resolved.relationship ?? emptyRelationshipMeta())
      : undefined;
  // Bundle lore stays in its bundle dir (`lore/<bundle>/<id>.md`); a rename
  // only changes the stem.
  const newPath = entryFilePath(state.cast, { ...resolved, id: nextId });
  const write: ActionWrite = {
    path: newPath,
    content: serializeEntry({
      name: nextName,
      description: nextDescription,
      kind: resolved.kind,
      body: nextBody,
      lore,
      character,
      relationship,
      extra: resolved.extra,
    }),
  };
  const removes: string[] = [];
  if (renamed) {
    const oldPath = entryFilePath(state.cast, resolved);
    // chooseSlug can hand back the old stem (e.g. `foo-2` renamed to `Foo`
    // while `foo` exists); never delete the file just written, even when
    // the paths differ only in case (same file on macOS / Windows).
    if (oldPath.toLowerCase() !== newPath.toLowerCase()) removes.push(oldPath);
  }
  const entry: RoleplayEntry = {
    id: nextId,
    kind: resolved.kind,
    name: nextName,
    description: nextDescription,
    ...(lore ? { lore } : {}),
    ...(character ? { character } : {}),
    ...(relationship ? { relationship } : {}),
    ...(resolved.extra ? { extra: resolved.extra } : {}),
    ...(resolved.bundle ? { bundle: resolved.bundle } : {}),
  };
  const next: RoleplayState = { cast: state.cast, entries: upsertEntry(entries, entry) };
  return {
    ok: true,
    writes: [write],
    removes,
    state: next,
    entry,
    content: `Updated [${next.cast}/${entry.kind}] ${entry.id} - ${entry.name}\n\n${formatText(next)}`,
  };
}

/** `remove`: delete the resolved entry's file (kind-scoped, so same-id entries of other kinds survive). */
export function planRemove(state: RoleplayState, params: RoleplayToolParams): ActionPlan {
  const resolved = resolveEntry(state, params);
  if ('error' in resolved) return fail(resolved.error);
  if (isReservedSlug(resolved.kind, resolved.id)) return fail(reservedRecordError(resolved.kind, resolved.id));
  const next: RoleplayState = { cast: state.cast, entries: removeEntry(state.entries, resolved.kind, resolved.id) };
  return {
    ok: true,
    writes: [],
    removes: [entryFilePath(state.cast, resolved)],
    state: next,
    entry: resolved,
    content: `Removed [${next.cast}/${resolved.kind}] ${resolved.id}\n\n${formatText(next)}`,
  };
}

/** `search`: case-insensitive match on name / description / id, then the stored body. */
export function planSearch(
  state: RoleplayState,
  params: RoleplayToolParams,
  readBody: ReadEntryBody,
): { ok: false; error: string } | { ok: true; matches: RoleplayEntry[]; content: string } {
  const q = (params.query ?? '').trim();
  if (q.length === 0) return { ok: false, error: '`query` is required for `search`' };
  const needle = q.toLowerCase();
  const matches: RoleplayEntry[] = [];
  for (const e of state.entries) {
    const hay = [e.name, e.description, e.id].join(' ').toLowerCase();
    if (hay.includes(needle)) {
      matches.push(e);
      continue;
    }
    const body = readBody(e);
    if (body?.toLowerCase().includes(needle)) matches.push(e);
  }
  if (matches.length === 0) return { ok: true, matches, content: `No entries in cast "${state.cast}" match "${q}".` };
  const lines = matches.map((e) => `  [${e.kind}] ${e.id} - ${e.name}: ${e.description}`);
  return { ok: true, matches, content: `Matches for "${q}" (${matches.length}):\n${lines.join('\n')}` };
}

/** Pre-computed writes for a card import (see {@link planCardImport}). */
export interface CardImportWritePlan {
  /** Files to write, in order; slugs already chosen against state + disk. */
  writes: ActionWrite[];
  /** Next in-memory state (commit after the writes, then rebuild the index / rescan). */
  state: RoleplayState;
  /** One `  [kind] slug - name` line per record, for the summary. */
  written: string[];
  /** The mapper's warnings plus any re-import warning. */
  warnings: string[];
}

/**
 * Plan the file writes for an imported card: one write per record with a
 * slug chosen up front against the in-memory state (case-insensitively)
 * and, via `exists`, files on disk the state does not know about, so an
 * import never overwrites an existing file. Warns when the cast already
 * holds a character of the same name (likely a re-import; the new records
 * land beside the old ones under suffixed slugs).
 */
export function planCardImport(state: RoleplayState, plan: ImportPlan, exists?: PathExists): CardImportWritePlan {
  const warnings = [...plan.warnings];
  const needle = plan.characterName.trim().toLowerCase();
  const dup = state.entries.find((e) => e.kind === 'character' && e.name.trim().toLowerCase() === needle);
  if (dup) {
    warnings.unshift(
      `cast "${state.cast}" already has a character named "${dup.name}" (${dup.id}); this looks like a re-import, so the new records are saved alongside the existing ones under suffixed slugs (remove the duplicates if unwanted)`,
    );
  }
  let entries = state.entries;
  const writes: ActionWrite[] = [];
  const written: string[] = [];
  for (const rec of plan.records) {
    const slug = chooseSlug(
      entries,
      rec.name,
      undefined,
      slugProbe(exists, (s) => fileFor(state.cast, rec.kind, s)),
    );
    writes.push({
      path: fileFor(state.cast, rec.kind, slug),
      content: serializeEntry({
        name: rec.name,
        description: rec.description,
        kind: rec.kind,
        body: rec.body,
        lore: rec.lore,
        character: rec.character,
      }),
    });
    const entry: RoleplayEntry = {
      id: slug,
      kind: rec.kind,
      name: rec.name,
      description: rec.description,
      ...(rec.lore ? { lore: rec.lore } : {}),
      ...(rec.character ? { character: rec.character } : {}),
    };
    entries = upsertEntry(entries, entry);
    written.push(`  [${rec.kind}] ${slug} - ${rec.name}`);
  }
  return { writes, state: { cast: state.cast, entries }, written, warnings };
}
