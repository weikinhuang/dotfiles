/**
 * Mode-file parser for `config/pi/extensions/mode.ts`.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 * The frontmatter parser is injected (matches `subagent-loader.ts`) so
 * the extension wires pi's `parseFrontmatter` while tests can drive the
 * loader with a stub.
 *
 * Schema is a strict superset of the agent frontmatter (see
 * `plans/pi-mode-extension.md` → "Mode file schema (frontmatter)").
 * Mode-only fields: `agent`, `writeRoots`, `bashAllow`, `bashDeny`,
 * `appendSystemPrompt`, `systemPromptOverride`. Validation collects
 * warnings rather than throwing - one bad mode file should never blind
 * the whole catalog.
 */

import { basename } from 'node:path';

import { parseRequestOptions, type RequestOptionsConfig } from '../request-options.ts';

const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type PersonaThinkingLevel = (typeof THINKING_LEVELS)[number];

export type PersonaSourceLayer = 'shipped' | 'user' | 'project';

/** Raw, untyped frontmatter - every field is `unknown` until validated. */
export interface PersonaFrontmatterRaw extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  agent?: unknown;
  tools?: unknown;
  writeRoots?: unknown;
  bashAllow?: unknown;
  bashDeny?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  appendSystemPrompt?: unknown;
  systemPromptOverride?: unknown;
  requestOptions?: unknown;
  roleplay?: unknown;
  cast?: unknown;
  characters?: unknown;
  pov?: unknown;
  openers?: unknown;
  authorNote?: unknown;
  authorNoteDepth?: unknown;
}

/**
 * Result of validating a mode `.md` file. `tools` is `undefined` when
 * the field is absent in frontmatter - the inheritance pass will pull
 * it from the referenced agent (D5 in the plan).
 */
export interface ParsedPersona {
  name: string;
  description?: string;
  agent?: string;
  tools?: string[];
  writeRoots: string[];
  bashAllow: string[];
  bashDeny: string[];
  model?: string;
  thinkingLevel?: PersonaThinkingLevel;
  appendSystemPrompt?: string;
  /**
   * Escape hatch that REPLACES the base system prompt entirely (rather
   * than appending like `body` / `appendSystemPrompt`). When set, the
   * `before_agent_start` hook uses this as the base prompt; the body
   * and `appendSystemPrompt` addendum are still appended after it.
   * Drops pi's default coding-agent scaffolding - intended for
   * non-coding personas (chat, journal, roleplay).
   */
  systemPromptOverride?: string;
  /** Free-form deep-merge into the outgoing provider payload. See `lib/node/pi/request-options.ts`. */
  requestOptions?: RequestOptionsConfig;
  /**
   * Opt-in master switch for the `roleplay` extension. The roleplay
   * tool, cast resolution, and the `## Roleplay` system-prompt block are
   * dormant unless the active persona sets `roleplay: true`. Keeps the
   * feature off for coding personas and persona-as-subagent uses.
   */
  roleplay: boolean;
  /**
   * Optional cast slug for the roleplay store. Defaults to the persona
   * name when `roleplay` is true and `cast` is omitted.
   */
  cast?: string;
  /**
   * Character names / ids (from the active cast) whose full body sheets
   * fold into the system prompt for the scene. Order is preserved. Inert
   * unless `roleplay` is true; missing names are warn-dropped by the
   * roleplay extension.
   */
  characters?: string[];
  /** The character the human plays; announced + folded last in the scene block. */
  pov?: string;
  /** Greeting lines surfaced via `/persona opener [n]`; not injected. */
  openers?: string[];
  /**
   * Optional author's note - a short standing instruction the roleplay
   * extension injects at conversational depth (not the system prompt) via
   * the `context` event, recomputed each turn. Inert unless `roleplay` is
   * true and the depth-injection aspect is enabled.
   */
  authorNote?: string;
  /** Depth (messages from the end) at which `authorNote` is inserted. Default 4. */
  authorNoteDepth?: number;
  body: string;
  /** Absolute path of the source file. */
  source: string;
  /** Layered-discovery tag (`shipped` / `user` / `project`). */
  sourceLayer: PersonaSourceLayer;
}

export interface PersonaWarning {
  path: string;
  reason: string;
}

export interface ParsePersonaOptions {
  path: string;
  source: PersonaSourceLayer;
  raw: string;
  knownToolNames: ReadonlySet<string>;
  parseFrontmatter: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  /** Mutated in place - same pattern as `subagent-loader.ts`. */
  warnings: PersonaWarning[];
}

function toStringOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length > 0) return t;
  return undefined;
}

/** Validate a string array; drop non-string entries with a per-entry warning. */
function toStringArray(value: unknown, field: string, path: string, warnings: PersonaWarning[]): string[] | undefined {
  if (!Array.isArray(value)) {
    warnings.push({ path, reason: `\`${field}\` must be an array of strings` });
    return undefined;
  }
  const kept: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      warnings.push({ path, reason: `\`${field}\` entry "${String(raw)}" is not a string (dropped)` });
      continue;
    }
    kept.push(raw);
  }
  return kept;
}

function stemFromPath(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  if (dot > 0) return base.slice(0, dot);
  return base;
}

/**
 * Parse one mode `.md` file. Returns `null` and pushes a warning when
 * the file is unusable (no frontmatter, parser threw, etc.). Unknown
 * frontmatter keys are tolerated silently.
 */
export function parsePersonaFile(opts: ParsePersonaOptions): ParsedPersona | null {
  const { path, raw, knownToolNames, parseFrontmatter, warnings, source } = opts;

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch (e) {
    warnings.push({ path, reason: e instanceof Error ? e.message : String(e) });
    return null;
  }

  if (!parsed.frontmatter || Object.keys(parsed.frontmatter).length === 0) {
    // No frontmatter - silently skip; the file is not a persona.
    return null;
  }

  const fm = parsed.frontmatter as PersonaFrontmatterRaw;

  // name: explicit FM value, else filename stem.
  const explicitName = toStringOrUndefined(fm.name);
  const name = explicitName ?? stemFromPath(path);

  const description = toStringOrUndefined(fm.description);
  const agent = toStringOrUndefined(fm.agent);

  // tools: undefined when omitted - inheritance pass fills from agent.
  let tools: string[] | undefined;
  if (fm.tools !== undefined) {
    const arr = toStringArray(fm.tools, 'tools', path, warnings);
    if (arr) {
      const kept: string[] = [];
      for (const raw2 of arr) {
        const t = raw2.trim();
        if (t.length === 0) continue;
        if (!knownToolNames.has(t)) {
          warnings.push({ path, reason: `unknown tool "${t}" (dropped)` });
          continue;
        }
        kept.push(t);
      }
      tools = kept;
    }
    // If `arr` is undefined (bad shape), `tools` stays undefined - the
    // mode is still returned, deferring tool resolution to inheritance
    // or to the caller noticing the warning.
  }

  // writeRoots / bashAllow / bashDeny: validated as plain string arrays.
  const writeRoots = fm.writeRoots !== undefined ? toStringArray(fm.writeRoots, 'writeRoots', path, warnings) : [];
  const bashAllow = fm.bashAllow !== undefined ? toStringArray(fm.bashAllow, 'bashAllow', path, warnings) : [];
  const bashDeny = fm.bashDeny !== undefined ? toStringArray(fm.bashDeny, 'bashDeny', path, warnings) : [];

  // model: 'inherit' is a sentinel; otherwise must look like provider/id.
  let model: string | undefined;
  if (fm.model !== undefined) {
    if (typeof fm.model !== 'string') {
      warnings.push({ path, reason: `\`model\` must be a string (got ${typeof fm.model})` });
    } else if (fm.model === 'inherit') {
      model = 'inherit';
    } else if (fm.model.includes('/')) {
      model = fm.model;
    } else {
      warnings.push({ path, reason: `invalid model "${fm.model}" (expected "inherit" or "provider/id")` });
    }
  }

  // thinkingLevel: one of the four canonical values.
  let thinkingLevel: PersonaThinkingLevel | undefined;
  if (fm.thinkingLevel !== undefined) {
    if (typeof fm.thinkingLevel === 'string' && (THINKING_LEVELS as readonly string[]).includes(fm.thinkingLevel)) {
      thinkingLevel = fm.thinkingLevel as PersonaThinkingLevel;
    } else {
      warnings.push({
        path,
        reason: `invalid thinkingLevel (must be one of: ${THINKING_LEVELS.join(', ')})`,
      });
    }
  }

  const appendSystemPrompt = toStringOrUndefined(fm.appendSystemPrompt);
  const systemPromptOverride = toStringOrUndefined(fm.systemPromptOverride);

  // roleplay: opt-in boolean. A non-boolean value is a config error.
  let roleplay = false;
  if (fm.roleplay !== undefined) {
    if (typeof fm.roleplay === 'boolean') roleplay = fm.roleplay;
    else warnings.push({ path, reason: `\`roleplay\` must be a boolean (got ${typeof fm.roleplay})` });
  }
  const cast = toStringOrUndefined(fm.cast);
  const characters =
    fm.characters !== undefined ? toStringArray(fm.characters, 'characters', path, warnings) : undefined;
  const pov = toStringOrUndefined(fm.pov);
  const openers = fm.openers !== undefined ? toStringArray(fm.openers, 'openers', path, warnings) : undefined;

  const authorNote = toStringOrUndefined(fm.authorNote);
  let authorNoteDepth: number | undefined;
  if (fm.authorNoteDepth !== undefined) {
    if (typeof fm.authorNoteDepth === 'number' && Number.isFinite(fm.authorNoteDepth) && fm.authorNoteDepth >= 0) {
      authorNoteDepth = Math.floor(fm.authorNoteDepth);
    } else {
      warnings.push({ path, reason: '`authorNoteDepth` must be a non-negative number' });
    }
  }

  const requestOptions = parseRequestOptions(fm.requestOptions, (reason) => warnings.push({ path, reason }));

  return {
    name,
    description,
    agent,
    tools,
    writeRoots: writeRoots ?? [],
    bashAllow: bashAllow ?? [],
    bashDeny: bashDeny ?? [],
    model,
    thinkingLevel,
    appendSystemPrompt,
    systemPromptOverride,
    requestOptions,
    roleplay,
    cast,
    characters,
    pov,
    openers,
    authorNote,
    authorNoteDepth,
    body: parsed.body,
    source: path,
    sourceLayer: source,
  };
}
