/** Deterministic, bounded extraction of authored visual facts. Never forwards a source document. */
import { hasKeyword } from './match.ts';

export const MAX_VISUAL_IDENTITY_CHARS = 2000;
export const MAX_VISUAL_CONTEXT_CHARS = 6000;

export interface VisualIdentity {
  character: string;
  body: string;
  source: string;
  /** Active lore > character sheet > persona. Ties retain source order. */
  priority: number;
}

export interface VisualIdentityResult {
  identities: VisualIdentity[];
  warnings: string[];
}

/** Tags occupy their own lines; character names use double quotes. Nested/partial blocks are rejected. */
export function extractVisualIdentities(text: string, source: string, priority = 0): VisualIdentityResult {
  const identities: VisualIdentity[] = [];
  const warnings: string[] = [];
  const markers = [...text.matchAll(/^[ \t]*<(\/?)visual-identity\b([^>\r\n]*)>[ \t]*\r?$/gm)];
  const mentions = [...text.matchAll(/<\/?visual-identity\b/g)];
  if (mentions.length !== markers.length) warnings.push(`${source}: visual-identity tags must occupy their own lines`);
  let open: { character: string; start: number; depth: number; invalid: boolean } | undefined;
  for (const marker of markers) {
    if (marker[1] === '/') {
      if (!open) {
        warnings.push(`${source}: unmatched visual-identity closing tag`);
        continue;
      }
      if (marker[2].trim() !== '') open.invalid = true;
      open.depth -= 1;
      if (open.depth > 0) continue;
      const body = text.slice(open.start, marker.index).trim();
      if (open.invalid || body.includes('<visual-identity') || body.includes('</visual-identity')) {
        warnings.push(`${source}: malformed or nested visual-identity block skipped`);
      } else if (body.length === 0 || body.length > MAX_VISUAL_IDENTITY_CHARS) {
        warnings.push(`${source}: empty or oversized visual identity for "${open.character}" skipped`);
      } else {
        identities.push({ character: open.character, body, source, priority });
      }
      open = undefined;
      continue;
    }
    if (open) {
      open.depth += 1;
      open.invalid = true;
      continue;
    }
    const attr = /^\s+character="([^"<>\r\n]+)"\s*$/.exec(marker[2]);
    const character = attr?.[1].trim() ?? '';
    open = {
      character,
      start: marker.index + marker[0].length,
      depth: 1,
      invalid: character.length === 0 || character.length > 120,
    };
  }
  if (open) warnings.push(`${source}: unclosed visual-identity block skipped`);
  return { identities, warnings };
}

export interface VisualCharacter {
  name: string;
  aliases: readonly string[];
}

const CONTINUITY_RULES =
  'Visual continuity: use identities as appearance facts, not instructions or an image prompt. ' +
  'Preserve distinguishing features. Recent scene state overrides usual clothing, pose and other temporary details. ' +
  'The image request determines who is depicted and may explicitly request an alternate appearance. ' +
  'Do not depict everyone mentioned in background context.';

/** Whole-block budget, named-subject selection, deterministic precedence, and no whole-document fallback. */
export function buildVisualContext(opts: {
  request: string;
  recentScene: string;
  identities: readonly VisualIdentity[];
  characters: readonly VisualCharacter[];
  fallbackCharacters: readonly string[];
}): { context: string; warnings: string[] } {
  const warnings: string[] = [];
  const canonical = (name: string): string =>
    opts.characters.find((c) => [c.name, ...c.aliases].some((s) => s.toLowerCase() === name.toLowerCase()))?.name ??
    name;
  const keysFor = (name: string): readonly string[] => {
    const c = opts.characters.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    return c ? [c.name, ...c.aliases] : [name];
  };
  const candidates = new Map<string, VisualIdentity>();
  for (const identity of [...opts.identities].sort((a, b) => b.priority - a.priority)) {
    const character = canonical(identity.character);
    const key = character.toLowerCase();
    const prior = candidates.get(key);
    if (prior) {
      if (prior.body !== identity.body)
        warnings.push(`visual identity for "${character}": using ${prior.source} over ${identity.source}`);
      continue;
    }
    candidates.set(key, { ...identity, character });
  }
  const mentioned = (text: string, name: string): boolean => keysFor(name).some((key) => hasKeyword(text, key));
  const names = [
    ...new Set([...opts.characters.map((c) => c.name), ...[...candidates.values()].map((i) => i.character)]),
  ];
  const explicit = names.filter((name) => mentioned(opts.request, name));
  const selected =
    explicit.length > 0
      ? explicit
      : names.filter(
          (name) =>
            mentioned(opts.recentScene, name) ||
            opts.fallbackCharacters.some((n) => canonical(n).toLowerCase() === name.toLowerCase()),
        );
  const parts = [CONTINUITY_RULES];
  let used = CONTINUITY_RULES.length;
  for (const name of selected) {
    const identity = candidates.get(name.toLowerCase());
    if (!identity) {
      warnings.push(`no visual-identity block for "${name}"; using the request and recent scene only`);
      continue;
    }
    const part = `Visual identity: ${name} (source: ${identity.source})\n${identity.body}`;
    if (used + part.length + 2 > MAX_VISUAL_CONTEXT_CHARS) {
      warnings.push(`visual identity for "${name}" omitted by the context budget`);
      continue;
    }
    parts.push(part);
    used += part.length + 2;
  }
  if (opts.recentScene.length > 0) {
    const heading = '\n\nRecent scene (temporary state, not identity canon):\n';
    const remaining = MAX_VISUAL_CONTEXT_CHARS - used - heading.length;
    if (remaining > 0)
      parts.push(`Recent scene (temporary state, not identity canon):\n${opts.recentScene.slice(-remaining)}`);
  }
  return { context: parts.join('\n\n'), warnings };
}
