/**
 * `roleplay` tool parameter shape + the pure param -> metadata builders the
 * `save` / `update` actions layer over an entry's existing metadata.
 *
 * The TypeBox schema stays in the extension shell (it is the tool's
 * registration surface); this is the structural TypeScript view of it.
 *
 * No pi imports.
 */

import {
  type CharacterMeta,
  emptyCharacterMeta,
  emptyLoreMeta,
  emptyRelationshipMeta,
  type LoreMeta,
  type RelationshipMeta,
  type RoleplayKind,
  type SecondaryMode,
} from './store.ts';

export interface RoleplayToolParams {
  action: 'list' | 'read' | 'save' | 'update' | 'remove' | 'search';
  kind?: RoleplayKind;
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  query?: string;
  triggers?: string[];
  secondaryKeys?: string[];
  secondaryMode?: SecondaryMode;
  constant?: boolean;
  order?: number;
  depth?: number;
  recurse?: boolean;
  aliases?: string[];
  pinned?: boolean;
  affinity?: number;
  trust?: string;
  lastInteraction?: string;
  openThreads?: string[];
}

/** Trim each keyword and drop blanks. */
function cleanList(xs: string[]): string[] {
  return xs.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Build lore metadata from tool params, layered over an optional base (for updates). Never mutates `base`. */
export function buildLoreMeta(params: RoleplayToolParams, base?: LoreMeta): LoreMeta {
  const meta: LoreMeta = base
    ? { ...base, triggers: [...base.triggers], secondaryKeys: [...base.secondaryKeys] }
    : emptyLoreMeta();
  if (params.triggers !== undefined) meta.triggers = cleanList(params.triggers);
  if (params.secondaryKeys !== undefined) meta.secondaryKeys = cleanList(params.secondaryKeys);
  if (params.secondaryMode !== undefined) meta.secondaryMode = params.secondaryMode;
  if (params.constant !== undefined) meta.constant = params.constant;
  if (params.order !== undefined) meta.order = Math.floor(params.order);
  if (params.depth !== undefined) {
    const depth = Math.floor(params.depth);
    if (depth >= 0) meta.depth = depth;
    else delete meta.depth;
  }
  if (params.recurse !== undefined) meta.recurse = params.recurse;
  return meta;
}

/** Build character-fold metadata from tool params, layered over an optional base (for updates). Never mutates `base`. */
export function buildCharacterMeta(params: RoleplayToolParams, base?: CharacterMeta): CharacterMeta {
  const meta: CharacterMeta = base
    ? { ...base, aliases: [...base.aliases], triggers: [...base.triggers] }
    : emptyCharacterMeta();
  if (params.aliases !== undefined) meta.aliases = cleanList(params.aliases);
  if (params.triggers !== undefined) meta.triggers = cleanList(params.triggers);
  if (params.pinned !== undefined) meta.pinned = params.pinned;
  if (params.order !== undefined) meta.order = Math.floor(params.order);
  return meta;
}

/**
 * Build relationship metadata from tool params, layered over an optional
 * base (for updates). Never mutates `base`. `affinity` clamps to 0-100; a
 * blank `lastInteraction` clears it (format validation is
 * `lastInteractionError` in `store.ts`, checked by the action first).
 */
export function buildRelationshipMeta(params: RoleplayToolParams, base?: RelationshipMeta): RelationshipMeta {
  const meta: RelationshipMeta = base ? { ...base, openThreads: [...base.openThreads] } : emptyRelationshipMeta();
  if (params.affinity !== undefined) meta.affinity = Math.min(100, Math.max(0, Math.floor(params.affinity)));
  if (params.trust !== undefined) meta.trust = params.trust.trim();
  if (params.lastInteraction !== undefined) {
    const v = params.lastInteraction.trim();
    if (v.length > 0) meta.lastInteraction = v;
    else delete meta.lastInteraction;
  }
  if (params.openThreads !== undefined) meta.openThreads = cleanList(params.openThreads);
  return meta;
}
