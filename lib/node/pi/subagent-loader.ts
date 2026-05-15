/**
 * Agent-definition loader for the subagent extension.
 *
 * Pure module — no pi imports — so it can be unit-tested under `vitest`.
 * File I/O is injected via a `ReadLayer` interface so the extension
 * wires up `fs.readdirSync` / `fs.readFileSync` while tests drive the
 * loader with in-memory fixtures.
 *
 * Each agent definition is a Markdown file with YAML frontmatter:
 *
 *   ---
 *   name: explore
 *   description: Read-only exploration...
 *   tools: [read, grep, find, ls]
 *   model: inherit
 *   thinkingLevel: low
 *   maxTurns: 12
 *   isolation: shared-cwd
 *   timeoutMs: 180000
 *   appendSystemPrompt: |
 *     extra prompt text
 *   ---
 *
 *   System prompt body...
 *
 * Definitions are merged across three priority layers (global defaults
 * shipped with the repo, user-scoped in `~/.pi/agents/`, project-scoped
 * in `<cwd>/.pi/agents/`). Later layers override by `name`.
 *
 * The loader validates:
 *   - `name` matches [a-z][a-z0-9-]* (required)
 *   - `description` is a non-empty string (required)
 *   - `tools` lives inside `knownToolNames`; unknown entries drop with a
 *     per-file warning
 *   - `model` is either `inherit` or `provider/id`
 *   - `thinkingLevel` is one of the canonical levels
 *   - `maxTurns`, `timeoutMs` are positive finite numbers
 *   - `isolation` is `shared-cwd` or `worktree`
 *
 * Malformed entries produce a diagnostic warning keyed to the offending
 * path; the whole file is skipped so one bad frontmatter never blinds
 * the whole agent set.
 */

import { join } from 'node:path';

import { parseModelSpec } from './btw.ts';
import { type ThinkingLevel, THINKING_LEVELS } from './preset.ts';

export type AgentModel = 'inherit' | { provider: string; modelId: string };
export type AgentIsolation = 'shared-cwd' | 'worktree';
export type AgentSourceLayer = 'global' | 'user' | 'project';

export const DEFAULT_AGENT_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];
export const DEFAULT_AGENT_MAX_TURNS = 20;
export const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ISOLATION_VALUES: readonly AgentIsolation[] = ['shared-cwd', 'worktree'];

import { parseRequestOptions, type RequestOptionsConfig } from './request-options.ts';

export interface AgentDef {
  /** Source path of the `.md` file. Useful for `/agents show`. */
  path: string;
  /** Which layer this definition came from (lowest layer that wins). */
  source: AgentSourceLayer;
  /** Agent identifier — what the LLM passes as `subagent(agent="…")`. */
  name: string;
  /** Human-facing "when to use" blurb — shown to the parent LLM. */
  description: string;
  /** Validated tool allowlist. */
  tools: string[];
  /** Resolved model spec. `inherit` means "same as parent". */
  model: AgentModel;
  /** Thinking level override, or undefined to inherit. */
  thinkingLevel: ThinkingLevel | undefined;
  /** Hard cap on agent turns — enforced by counting `turn_end`. */
  maxTurns: number;
  /** Wall-clock cap in ms — enforced by an aborting timer. */
  timeoutMs: number;
  /** `shared-cwd` reuses parent cwd; `worktree` spins up a git worktree. */
  isolation: AgentIsolation;
  /** Optional extra text appended to the default system prompt. */
  appendSystemPrompt: string | undefined;
  /**
   * Optional bash command-prefix allowlist enforced inside the child
   * session. Same matcher semantics as persona's `bashAllow` (see
   * `lib/node/pi/persona/bash-policy.ts`). Empty list means "no opinion".
   */
  bashAllow: string[];
  /** Optional bash deny patterns enforced inside the child session. */
  bashDeny: string[];
  /**
   * Positive `write` / `edit` allowlist enforced inside the child
   * session. Resolution mirrors persona's `writeRoots`. Empty list
   * means writes are unconstrained inside the child (current default).
   */
  writeRoots: string[];
  /** Optional `requestOptions` block deep-merged into the child's provider payload. */
  requestOptions?: RequestOptionsConfig;
  /** Markdown body — the agent's role prompt. */
  body: string;
}

export interface AgentLoadWarning {
  path: string;
  reason: string;
}

export interface AgentLoadResult {
  /** Winning agents, keyed by name. */
  agents: Map<string, AgentDef>;
  /** Alphabetical order for deterministic listing. */
  nameOrder: string[];
  /** All diagnostics — surface once per unique `(path, reason)`. */
  warnings: AgentLoadWarning[];
}

export interface ReadLayer {
  /** Return a list of filenames in `dir`, or `null` if the dir is missing. */
  listMarkdownFiles: (dir: string) => string[] | null;
  /** Read file contents as UTF-8, or `null` on error. */
  readFile: (path: string) => string | null;
}

/** Shape of pi's `parseFrontmatter` exported from `@earendil-works/pi-coding-agent`. */
export type FrontmatterParser = (content: string) => { frontmatter: Record<string, unknown>; body: string };

export interface LoadAgentsOptions {
  /** Ordered lowest→highest priority. Typically `[global, user, project]`. */
  layers: { source: AgentSourceLayer; dir: string }[];
  /** Every tool name pi currently exposes — used to validate `tools`. */
  knownToolNames: ReadonlySet<string>;
  /** File I/O adapter. */
  fs: ReadLayer;
  /** Frontmatter parser — inject pi's `parseFrontmatter` at the extension layer. */
  parseFrontmatter: FrontmatterParser;
}

interface FrontmatterRaw extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  maxTurns?: unknown;
  timeoutMs?: unknown;
  isolation?: unknown;
  appendSystemPrompt?: unknown;
  bashAllow?: unknown;
  bashDeny?: unknown;
  writeRoots?: unknown;
  requestOptions?: unknown;
}

function toStringOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function toPositiveNumber(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

/**
 * Validate an arbitrary `string[]` frontmatter field. `undefined` skips
 * silently; anything else that isn't `string[]` warns and returns
 * `undefined`. Per-entry non-string values are dropped with a warning.
 */
function toStringArray(
  value: unknown,
  field: string,
  path: string,
  warnings: AgentLoadWarning[],
): string[] | undefined {
  if (value === undefined) return undefined;
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

/**
 * Validate a raw frontmatter object + body and return a concrete
 * `AgentDef`, or `null` with a warning when the file is unusable.
 * Unknown frontmatter keys are tolerated and ignored.
 */
export function validateAgent(args: {
  path: string;
  source: AgentSourceLayer;
  frontmatter: FrontmatterRaw;
  body: string;
  knownToolNames: ReadonlySet<string>;
  warnings: AgentLoadWarning[];
}): AgentDef | null {
  const { path, source, frontmatter: fm, body, knownToolNames, warnings } = args;

  const name = toStringOrUndefined(fm.name);
  if (!name) {
    warnings.push({ path, reason: '`name` is required' });
    return null;
  }
  if (!NAME_PATTERN.test(name)) {
    warnings.push({ path, reason: `name "${name}" must match [a-z][a-z0-9-]*` });
    return null;
  }

  const description = toStringOrUndefined(fm.description);
  if (!description) {
    warnings.push({ path, reason: '`description` is required' });
    return null;
  }

  // Tools — default when absent, validate every entry when present.
  let tools: string[] = [...DEFAULT_AGENT_TOOLS];
  if (fm.tools !== undefined) {
    if (!Array.isArray(fm.tools)) {
      warnings.push({ path, reason: '`tools` must be an array of strings' });
      return null;
    }
    const kept: string[] = [];
    for (const raw of fm.tools) {
      if (typeof raw !== 'string') {
        warnings.push({ path, reason: `tool entry "${String(raw)}" is not a string` });
        continue;
      }
      const t = raw.trim();
      if (!t) continue;
      if (!knownToolNames.has(t)) {
        warnings.push({ path, reason: `unknown tool "${t}" (dropped)` });
        continue;
      }
      kept.push(t);
    }
    tools = kept;
  }

  // Model.
  let model: AgentModel = 'inherit';
  if (fm.model !== undefined && fm.model !== 'inherit') {
    const spec = typeof fm.model === 'string' ? parseModelSpec(fm.model) : undefined;
    if (!spec) {
      const displayed = typeof fm.model === 'string' ? fm.model : JSON.stringify(fm.model);
      warnings.push({ path, reason: `invalid model "${displayed}" (expected "inherit" or "provider/id")` });
      return null;
    }
    model = spec;
  }

  // Thinking level. `inherit` is accepted as a synonym for
  // "unset" so agent frontmatter can mirror the `model: inherit`
  // spelling without the loader rejecting the whole agent.
  let thinkingLevel: ThinkingLevel | undefined;
  if (fm.thinkingLevel !== undefined && fm.thinkingLevel !== 'inherit') {
    if (typeof fm.thinkingLevel !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(fm.thinkingLevel)) {
      warnings.push({
        path,
        reason: `invalid thinkingLevel (must be one of: ${THINKING_LEVELS.join(', ')}, or "inherit")`,
      });
      return null;
    }
    thinkingLevel = fm.thinkingLevel as ThinkingLevel;
  }

  const maxTurns = fm.maxTurns !== undefined ? toPositiveNumber(fm.maxTurns) : DEFAULT_AGENT_MAX_TURNS;
  if (!maxTurns) {
    warnings.push({ path, reason: '`maxTurns` must be a positive number' });
    return null;
  }
  const timeoutMs = fm.timeoutMs !== undefined ? toPositiveNumber(fm.timeoutMs) : DEFAULT_AGENT_TIMEOUT_MS;
  if (!timeoutMs) {
    warnings.push({ path, reason: '`timeoutMs` must be a positive number' });
    return null;
  }

  let isolation: AgentIsolation = 'shared-cwd';
  if (fm.isolation !== undefined) {
    if (typeof fm.isolation !== 'string' || !(ISOLATION_VALUES as readonly string[]).includes(fm.isolation)) {
      warnings.push({ path, reason: `isolation must be one of: ${ISOLATION_VALUES.join(', ')}` });
      return null;
    }
    isolation = fm.isolation as AgentIsolation;
  }

  const appendSystemPrompt = toStringOrUndefined(fm.appendSystemPrompt);

  // bashAllow / bashDeny / writeRoots: per-agent gates enforced inside
  // the child session via the inline `agent-gate` extension factory
  // (see `config/pi/extensions/subagent.ts`). Empty arrays mean "no
  // opinion". Same matcher semantics as the persona equivalents.
  const bashAllow = toStringArray(fm.bashAllow, 'bashAllow', path, warnings) ?? [];
  const bashDeny = toStringArray(fm.bashDeny, 'bashDeny', path, warnings) ?? [];
  const writeRoots = toStringArray(fm.writeRoots, 'writeRoots', path, warnings) ?? [];

  const requestOptions = parseRequestOptions(fm.requestOptions, (reason) => warnings.push({ path, reason }));

  return {
    path,
    source,
    name,
    description,
    tools,
    model,
    thinkingLevel,
    maxTurns,
    timeoutMs,
    isolation,
    appendSystemPrompt,
    bashAllow,
    bashDeny,
    writeRoots,
    requestOptions,
    body: body.trimEnd(),
  };
}

/**
 * Walk each layer in order, parse every `*.md` file, validate, and
 * merge by name (highest-priority layer wins). Returns the winning
 * agents, a deterministic order for listing, and every diagnostic.
 */
export function loadAgents(options: LoadAgentsOptions): AgentLoadResult {
  const { layers, knownToolNames, fs, parseFrontmatter } = options;
  const agents = new Map<string, AgentDef>();
  const warnings: AgentLoadWarning[] = [];

  for (const layer of layers) {
    const names = fs.listMarkdownFiles(layer.dir);
    if (!names) continue;
    for (const fname of names) {
      if (!fname.endsWith('.md')) continue;
      // README.md is documentation for humans, not an agent spec — skip it
      // without emitting a `missing or empty frontmatter` warning.
      if (fname.toLowerCase() === 'readme.md') continue;
      const path = join(layer.dir, fname);
      const raw = fs.readFile(path);
      if (raw === null) {
        warnings.push({ path, reason: 'unreadable' });
        continue;
      }
      let parsed: { frontmatter: Record<string, unknown>; body: string };
      try {
        parsed = parseFrontmatter(raw);
      } catch (e) {
        warnings.push({ path, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!parsed.frontmatter || Object.keys(parsed.frontmatter).length === 0) {
        warnings.push({ path, reason: 'missing or empty frontmatter' });
        continue;
      }
      const agent = validateAgent({
        path,
        source: layer.source,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        knownToolNames,
        warnings,
      });
      if (agent) agents.set(agent.name, agent);
    }
  }

  const nameOrder = [...agents.keys()].sort();
  return { agents, nameOrder, warnings };
}

/**
 * Helper: given `~/.dotfiles/config/pi/extensions` (where this file
 * resolves from) + cwd + homedir, return the three agent-definition
 * directories in priority order (global → user → project).
 */
export function defaultAgentLayers(args: {
  /** Directory containing the extension file (e.g. `.../extensions`). */
  extensionDir: string;
  /** User-scoped pi config dir (e.g. `~/.pi`). */
  userPiDir: string;
  /** Project cwd (e.g. `ctx.cwd`). */
  cwd: string;
}): { source: AgentSourceLayer; dir: string }[] {
  return [
    { source: 'global', dir: join(args.extensionDir, '..', 'agents') },
    { source: 'user', dir: join(args.userPiDir, 'agents') },
    { source: 'project', dir: join(args.cwd, '.pi', 'agents') },
  ];
}
