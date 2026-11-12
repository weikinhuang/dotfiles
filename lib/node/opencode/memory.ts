/**
 * Pure helpers for the opencode `memory` plugin
 * (config/opencode/plugins/memory/): option resolution, the `memory` tool
 * schema / description / input validation, and the `/memory` report text.
 *
 * The plugin shares pi's on-disk store (`~/.pi/agent/memory/` by default):
 * the actions are lib/node/pi/memory/actions.ts and the layout is
 * lib/node/pi/memory-paths.ts, so files, slugs, and `MEMORY.md` indices are
 * byte-identical across both hosts.
 *
 * Pure module - no opencode imports.
 */

import { homedir } from 'node:os';

import { globalDir, memoryRoot, projectDir, projectSlug, sessionDir } from '../pi/memory-paths.ts';
import { DEFAULT_MAX_INDEX_CHARS, MIN_INDEX_CHARS, renderMemoryIndex } from '../pi/memory-prompt.ts';
import {
  DEFAULT_STALE_DAYS,
  entryAgeDays,
  formatText,
  isStaleEntry,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
} from '../pi/memory-reducer.ts';
import { MEMORY_ACTIONS, type MemoryAction, type MemoryActionParams } from '../pi/memory/actions.ts';
import { type RenderedFullIndex } from '../pi/memory/delivery.ts';
import { expandTilde } from '../pi/path-expand.ts';
import { type MemoryDeliveryState, planInstructionDelivery } from './memory-delivery.ts';
import { createOptionReader, type EnvBag, parseNonEmptyString, type PluginOptionBag } from './plugin-options.ts';

export const OPENCODE_MEMORY_ENV_PREFIX = 'OPENCODE_MEMORY_';

export interface OpencodeMemoryConfig {
  enabled: boolean;
  /** Store root (shared with pi). */
  root: string;
  /** Deliver the index as session instruction entries. */
  autoInject: boolean;
  /** `memory is read-only: <reason>` for writes, or `undefined` when writable. */
  readOnlyReason: string | undefined;
  maxInjectedChars: number;
  staleDays: number;
}

function parsePositiveInteger(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Resolve options (`ctx.options`) and `OPENCODE_MEMORY_*` env overrides.
 * The default root is pi's own (`PI_MEMORY_ROOT`, else
 * `<PI_CODING_AGENT_DIR or ~/.pi/agent>/memory`), so both hosts share it.
 */
export function resolveOpencodeMemoryConfig(
  options: PluginOptionBag | undefined,
  env: EnvBag,
  home: string = homedir(),
): OpencodeMemoryConfig {
  const read = createOptionReader(options, env, OPENCODE_MEMORY_ENV_PREFIX);
  const root = read.get('root', parseNonEmptyString);
  const readOnly = read.bool('readOnly', false);
  return {
    enabled: read.bool('enabled', true),
    root: root ? expandTilde(root, home) : memoryRoot(env, home),
    autoInject: read.bool('autoInject', true),
    readOnlyReason: readOnly ? `readOnly (${read.envName('readOnly')})` : undefined,
    maxInjectedChars: Math.max(
      MIN_INDEX_CHARS,
      read.get('maxInjectedChars', parsePositiveInteger) ?? DEFAULT_MAX_INDEX_CHARS,
    ),
    staleDays: read.get('staleDays', parsePositiveInteger) ?? DEFAULT_STALE_DAYS,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tool
// ──────────────────────────────────────────────────────────────────────

export const MEMORY_TOOL = 'memory';

export const MEMORY_TOOL_DESCRIPTION = [
  'Persistent multi-layered memory (shared with pi): durable notes about the user, feedback, project, and external references that survive across sessions, plus session-scoped `note`s for this session only. The index of saved memories is in your context; `read` loads a full body.',
  'Actions: list, read (id), save ({type, name, description, body, scope?}), update (id, {name?, description?, body?}), remove (id, scope), search (query).',
  '- Save when the user corrects your approach, states a preference, validates a non-obvious choice, or references an external system. Give a one-line `description`; for feedback/project, lead the body with the rule/fact, then **Why:** and **How to apply:** lines. Convert relative dates to absolute.',
  '- Do NOT save code patterns, architecture, file paths, git history, debugging recipes, anything already in AGENTS.md, ephemeral task state, or secrets - read the code or `git log` instead.',
  '- Default scopes: user/feedback -> global, project/reference -> project (this workspace), note -> session. Use `scope: project` for a user/feedback rule that only applies here.',
  '- Prefer `update` over saving a near-duplicate. Before relying on a memory, verify it still holds; `update` or `remove` stale ones.',
].join('\n');

export const MEMORY_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...MEMORY_ACTIONS] },
    type: {
      type: 'string',
      enum: [...MEMORY_TYPES],
      description:
        'Memory type. Required for `save` (session scope defaults to `note`). For `read`/`update`/`remove`, disambiguates when an id exists in multiple types. `note` is session-only.',
    },
    scope: {
      type: 'string',
      enum: [...MEMORY_SCOPES],
      description:
        'Scope. Defaults: user/feedback -> global, project/reference -> project, note -> session. `session` is not loaded by other sessions. Required for `remove`.',
    },
    id: { type: 'string', description: 'Memory slug (for `read` / `update` / `remove`), as shown in the index.' },
    name: { type: 'string', description: 'Human-readable title. Required for `save`; slugifies into the filename.' },
    description: {
      type: 'string',
      description: 'One-line hook shown in the index; future sessions use it to decide whether to `read` the entry.',
    },
    body: { type: 'string', description: 'Full memory content (markdown).' },
    query: { type: 'string', description: 'Search words (for `search`); matches name, description, and body.' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const STRING_FIELDS = ['id', 'name', 'description', 'body', 'query'] as const;

function isOneOf<T extends string>(values: readonly T[], raw: unknown): raw is T {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw);
}

/** Validate the tool's `unknown` input into the shared action params. */
export function parseMemoryToolInput(raw: unknown): ParseResult<MemoryActionParams> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'input must be an object' };
  const input = raw as Record<string, unknown>;
  if (!isOneOf<MemoryAction>(MEMORY_ACTIONS, input.action)) {
    return { ok: false, error: `\`action\` must be one of ${MEMORY_ACTIONS.join(', ')}` };
  }
  const value: MemoryActionParams = { action: input.action };
  if (input.type !== undefined) {
    if (!isOneOf<MemoryType>(MEMORY_TYPES, input.type)) {
      return { ok: false, error: `\`type\` must be one of ${MEMORY_TYPES.join(', ')}` };
    }
    value.type = input.type;
  }
  if (input.scope !== undefined) {
    if (!isOneOf<MemoryScope>(MEMORY_SCOPES, input.scope)) {
      return { ok: false, error: `\`scope\` must be one of ${MEMORY_SCOPES.join(', ')}` };
    }
    value.scope = input.scope;
  }
  for (const key of STRING_FIELDS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') return { ok: false, error: `\`${key}\` must be a string` };
    value[key] = field;
  }
  return { ok: true, value };
}

// ──────────────────────────────────────────────────────────────────────
// Index rendering + `/memory` reports
// ──────────────────────────────────────────────────────────────────────

/** Render the full `## Memory` block for delivery. */
export function renderFullIndex(
  state: MemoryState,
  config: Pick<OpencodeMemoryConfig, 'maxInjectedChars' | 'staleDays'>,
  now: Date,
): RenderedFullIndex | null {
  const rendered = renderMemoryIndex(state, { maxChars: config.maxInjectedChars, now, staleDays: config.staleDays });
  return rendered ? { body: rendered.body, truncated: rendered.skipped > 0 } : null;
}

export const MEMORY_REPORT_VIEWS = ['list', 'preview', 'dir', 'stale'] as const;
export type MemoryReportView = (typeof MEMORY_REPORT_VIEWS)[number];

export interface MemoryReportRequest {
  sessionID: string;
  view: MemoryReportView;
}

/** Validate the RPC `report` input. */
export function parseReportRequest(raw: unknown): ParseResult<MemoryReportRequest> {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.sessionID !== 'string' || input.sessionID === '') return { ok: false, error: 'sessionID required' };
  if (!isOneOf<MemoryReportView>(MEMORY_REPORT_VIEWS, input.view)) {
    return { ok: false, error: `view must be one of ${MEMORY_REPORT_VIEWS.join(', ')}` };
  }
  return { ok: true, value: { sessionID: input.sessionID, view: input.view } };
}

export interface MemoryReportInput {
  view: MemoryReportView;
  state: MemoryState;
  config: OpencodeMemoryConfig;
  cwd: string;
  sessionID: string;
  /** The session's delivery state (for `preview`). */
  delivery: MemoryDeliveryState | null;
  /** Subagent child session: no tool, no index. */
  child: boolean;
  /** Scan warnings (malformed files). */
  warnings: readonly string[];
  now: Date;
  env: EnvBag;
}

function previewReport(input: MemoryReportInput): string {
  const { state, config, now } = input;
  if (!config.autoInject) return `Index delivery is off (autoInject: false).\n\n${formatText(state)}`;
  if (input.child) return 'Subagent session: the memory index and tool are not available here.';
  const plan = planInstructionDelivery(input.delivery, state.index, () => renderFullIndex(state, config, now));
  const full = renderFullIndex(state, config, now);
  const fullText = full
    ? `\n\nFull index (${full.body.length} chars, cap ${config.maxInjectedChars}):\n\n${full.body}`
    : '';
  if (plan.kind === 'none') {
    return full
      ? `Index unchanged since it was last delivered; the next prompt adds nothing.${fullText}`
      : '(no memories - nothing is delivered)';
  }
  const lines = plan.ops.map((op) =>
    op.op === 'put' ? `put <context key="${op.key}">:\n\n${op.value}` : `remove ${op.key}`,
  );
  return `Next prompt (${plan.kind}):\n\n${lines.join('\n\n')}${plan.kind === 'full' ? '' : fullText}`;
}

function staleReport(state: MemoryState, staleDays: number, now: Date): string {
  const stale = state.index.project
    .filter((e) => isStaleEntry(e, now, staleDays))
    .map((e) => ({ entry: e, age: entryAgeDays(e, now) ?? 0 }))
    .sort((a, b) => b.age - a.age);
  if (stale.length === 0) return `No project memories older than ${staleDays}d (staleDays).`;
  const lines = stale.map(({ entry, age }) => `  ${entry.id} (${age}d) - ${entry.name}: ${entry.description}`);
  return `${stale.length} stale project memory(ies) older than ${staleDays}d (oldest first):\n${lines.join('\n')}`;
}

/** Text for one `/memory` view. */
export function buildMemoryReport(input: MemoryReportInput): string {
  const { state, config, cwd, sessionID } = input;
  const warnings = input.warnings.length > 0 ? `\n\nWarnings:\n${input.warnings.map((w) => `  ${w}`).join('\n')}` : '';
  switch (input.view) {
    case 'list':
      return `${formatText(state)}${warnings}`;
    case 'preview':
      return previewReport(input);
    case 'stale':
      return staleReport(state, config.staleDays, input.now);
    case 'dir': {
      const pinned = input.env.PI_MEMORY_PROJECT_SLUG?.trim() ? ' (PI_MEMORY_PROJECT_SLUG)' : '';
      return [
        `Memory root: ${config.root}`,
        `Global:  ${globalDir(config.root)}`,
        `Project: ${projectDir(cwd, config.root)}`,
        `Session: ${sessionDir(cwd, sessionID, config.root)}`,
        `Project slug: ${projectSlug(cwd)}${pinned}`,
        `Session id: ${sessionID}`,
      ].join('\n');
    }
  }
}
