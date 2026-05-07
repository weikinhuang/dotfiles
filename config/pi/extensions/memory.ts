/**
 * Memory extension for pi — cross-session, multi-layered durable notes.
 *
 * Port of Claude Code's "auto memory" feature. Durable knowledge is
 * kept as small markdown files on disk and indexed by a per-scope
 * `MEMORY.md` file. Each turn the extension injects the indices into
 * the system prompt under a `## Memory` header so the model sees what
 * durable context is available without a tool call; full bodies are
 * fetched on demand via `memory read <id>`.
 *
 * Memory types:
 *   - `user`      — facts about the user (role, preferences, expertise). Cross-project by default.
 *   - `feedback`  — corrections + validated approaches (don't-do-X / keep-doing-Y). Cross-project by default.
 *   - `project`   — initiatives, decisions, incidents for *this* workspace.
 *   - `reference` — pointers to external systems (Linear projects, dashboards). Per-workspace.
 *
 * Scopes:
 *   - `global`    — `<root>/global/<type>/<slug>.md`, shared across every pi session.
 *   - `project`   — `<root>/projects/<cwd-slug>/<type>/<slug>.md`, keyed on the cwd
 *                   the same way pi keys `~/.pi/agent/sessions/<cwd-slug>/`.
 *
 * Disk is the source of truth. On `session_start` the extension scans
 * the memory directories and rebuilds its in-memory index. Tool writes
 * go straight to disk, then re-emit the MEMORY.md index file; the
 * extension also mirrors the index snapshot (not bodies) into a
 * `memory-state` branch custom entry so `/fork` / `/tree` shows the
 * correct index at that point.
 *
 * Pure logic lives in `../../../lib/node/pi/memory-*.ts` so it can be
 * unit-tested under `vitest` without the pi runtime; this file holds
 * only the pi-coupled glue + disk I/O.
 *
 * Environment:
 *   PI_MEMORY_DISABLED=1             skip the extension entirely.
 *   PI_MEMORY_DISABLE_AUTOINJECT=1   tool still works but skip the
 *                                    before_agent_start block.
 *   PI_MEMORY_MAX_INJECTED_CHARS=N   soft cap on injected index (default 3000).
 *   PI_MEMORY_ROOT=<path>            override `~/.pi/agent/memory`.
 */

import { existsSync, readFileSync } from 'node:fs';

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  atomicWriteFile,
  cwdSlug,
  fileFor,
  globalDir,
  indexFileFor,
  memoryRoot,
  projectDir,
  removeFileIfExists,
  scanScope,
  slugifyName,
  uniqueSlug,
} from '../../../lib/node/pi/memory-paths.ts';
import { formatMemoryIndex } from '../../../lib/node/pi/memory-prompt.ts';
import {
  cloneState,
  emptyState,
  findEntry,
  formatText,
  MEMORY_CUSTOM_TYPE,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
  parseFrontmatter,
  removeEntry,
  renderMemoryMd,
  serializeMemory,
  takenSlugs,
  upsertEntry,
} from '../../../lib/node/pi/memory-reducer.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

const MAX_INJECTED_CHARS_DEFAULT = 3000;

// ──────────────────────────────────────────────────────────────────────
// Tool params
// ──────────────────────────────────────────────────────────────────────

const MemoryParams = Type.Object({
  action: StringEnum(['list', 'read', 'save', 'update', 'remove', 'search'] as const),
  type: Type.Optional(
    StringEnum(['user', 'feedback', 'project', 'reference'] as const, {
      description:
        'Memory type. Required for `save`. For `read`/`update`/`remove` it disambiguates when the same id exists in multiple types.',
    }),
  ),
  scope: Type.Optional(
    StringEnum(['global', 'project'] as const, {
      description:
        'Scope. Defaults: user/feedback → global, project/reference → project. Required for `remove` to avoid deleting the wrong one.',
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: 'Memory slug (for `read` / `update` / `remove`). See the ids in `list` or the injected index.',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: 'Human-readable title. Required for `save`; slugifies into the filename.',
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        'One-line hook shown in the MEMORY.md index. Used by future sessions to decide whether to `read` this entry.',
    }),
  ),
  body: Type.Optional(
    Type.String({
      description:
        'Full memory content (markdown). For feedback/project, lead with the rule/fact, then **Why:** and **How to apply:** lines.',
    }),
  ),
  query: Type.Optional(
    Type.String({ description: 'Case-insensitive search term (for `search`). Matches name, description, and body.' }),
  ),
});

// Mirrors the TypeBox schema above. Kept explicit (rather than derived via
// typebox's `Static<typeof MemoryParams>`) so the local action helpers can
// be read at a glance. Must stay in sync with `MemoryParams` — if you add
// a field there, add it here too.
interface MemoryParamsT {
  action: 'list' | 'read' | 'save' | 'update' | 'remove' | 'search';
  type?: MemoryType;
  scope?: MemoryScope;
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  query?: string;
}

interface MemoryDetails {
  action: string;
  state: MemoryState;
  entry?: MemoryEntry;
  matches?: MemoryEntry[];
  body?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function defaultScope(type: MemoryType): MemoryScope {
  return type === 'project' || type === 'reference' ? 'project' : 'global';
}

function isTypeAllowedInScope(type: MemoryType, scope: MemoryScope): boolean {
  if (scope === 'global') return type === 'user' || type === 'feedback';
  return true;
}

function writeIndex(scope: MemoryScope, cwd: string, entries: MemoryEntry[]): void {
  const md = renderMemoryMd(
    entries.filter((e) => e.scope === scope),
    scope,
  );
  atomicWriteFile(indexFileFor(scope, cwd), md);
}

/**
 * Pick a slug for a new memory: prefer the name-slug; if it collides
 * within the same scope, disambiguate with -2/-3. `excludeId` lets
 * rename-in-place skip the outgoing entry's own slug so `alice` → `alice`
 * stays `alice` instead of becoming `alice-2`.
 */
function chooseSlug(state: MemoryState, scope: MemoryScope, name: string, excludeId?: string): string {
  const base = slugifyName(name);
  const taken = takenSlugs(state.index, scope);
  if (excludeId !== undefined) taken.delete(excludeId);
  return uniqueSlug(base, taken);
}

function resolveEntry(
  state: MemoryState,
  params: { id?: string; type?: MemoryType; scope?: MemoryScope },
): MemoryEntry | { error: string } {
  if (!params.id) return { error: '`id` is required' };
  const scopes: MemoryScope[] = params.scope ? [params.scope] : ['project', 'global'];
  for (const scope of scopes) {
    const e = findEntry(state.index, scope, params.id);
    if (!e) continue;
    if (params.type && e.type !== params.type) continue;
    return e;
  }
  return { error: `no memory "${params.id}" found${params.scope ? ` in scope "${params.scope}"` : ''}` };
}

function fileBodyFor(entry: MemoryEntry, cwd: string): string | null {
  const path = fileFor(entry.scope, entry.type, entry.id, cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseFrontmatter(raw);
    return parsed ? parsed.body : raw;
  } catch {
    return null;
  }
}

function rebuildIndex(cwd: string): { state: MemoryState; warnings: string[] } {
  const slug = cwdSlug(cwd);
  const warnings: string[] = [];
  const g = scanScope(globalDir(), 'global');
  const p = scanScope(projectDir(cwd), 'project');
  for (const w of [...g.warnings, ...p.warnings]) warnings.push(`${w.path}: ${w.reason}`);
  return {
    state: { index: { global: g.entries, project: p.entries }, projectSlug: slug },
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function memoryExtension(pi: ExtensionAPI): void {
  if (process.env.PI_MEMORY_DISABLED === '1') return;

  const autoInjectEnabled = process.env.PI_MEMORY_DISABLE_AUTOINJECT !== '1';
  const maxInjectedChars = (() => {
    const raw = process.env.PI_MEMORY_MAX_INJECTED_CHARS;
    if (!raw) return MAX_INJECTED_CHARS_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 500 ? n : MAX_INJECTED_CHARS_DEFAULT;
  })();

  let state: MemoryState = emptyState();
  let cwd: string = process.cwd();
  const surfacedWarnings = new Set<string>();

  const rebuildFromDisk = (ctx: ExtensionContext): void => {
    cwd = ctx.cwd;
    const { state: next, warnings } = rebuildIndex(cwd);
    state = next;
    for (const w of warnings) {
      if (surfacedWarnings.has(w)) continue;
      surfacedWarnings.add(w);
      ctx.ui.notify(`memory: ${w}`, 'warning');
    }
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // Bookkeeping must never break initialization.
    }
  };

  pi.on('session_start', (_event, ctx) => {
    rebuildFromDisk(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    rebuildFromDisk(ctx);
  });

  if (autoInjectEnabled) {
    pi.on('before_agent_start', (event) => {
      const block = formatMemoryIndex(state, { maxChars: maxInjectedChars });
      if (!block) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────

  const actList = (): { content: string; details: MemoryDetails } => {
    return {
      content: formatText(state),
      details: { action: 'list', state: cloneState(state) },
    };
  };

  const actRead = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'read', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    const body = fileBodyFor(resolved, cwd);
    if (body == null) {
      const error = `memory "${resolved.id}" not readable on disk`;
      return {
        content: `Error: ${error}`,
        details: { action: 'read', state: cloneState(state), error },
        isError: true,
      };
    }
    const header = `[${resolved.scope}/${resolved.type}] ${resolved.id} — ${resolved.name}\n${resolved.description}\n`;
    return {
      content: `${header}\n${body.trim()}\n`,
      details: { action: 'read', state: cloneState(state), entry: { ...resolved }, body },
    };
  };

  const actSave = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    if (!params.type) {
      return {
        content: 'Error: `type` is required for `save`',
        details: { action: 'save', state: cloneState(state), error: '`type` is required' },
        isError: true,
      };
    }
    if (!params.name || params.name.trim().length === 0) {
      return {
        content: 'Error: `name` is required for `save`',
        details: { action: 'save', state: cloneState(state), error: '`name` is required' },
        isError: true,
      };
    }
    const description = (params.description ?? '').trim();
    if (description.length === 0) {
      return {
        content: 'Error: `description` is required for `save` (used as the one-line hook in MEMORY.md)',
        details: { action: 'save', state: cloneState(state), error: '`description` is required' },
        isError: true,
      };
    }
    const body = (params.body ?? '').trim();
    if (body.length === 0) {
      return {
        content: 'Error: `body` is required for `save`',
        details: { action: 'save', state: cloneState(state), error: '`body` is required' },
        isError: true,
      };
    }
    const scope = params.scope ?? defaultScope(params.type);
    if (!isTypeAllowedInScope(params.type, scope)) {
      const error = `type "${params.type}" cannot be saved in scope "${scope}" (use scope "project")`;
      return {
        content: `Error: ${error}`,
        details: { action: 'save', state: cloneState(state), error },
        isError: true,
      };
    }
    const slug = chooseSlug(state, scope, params.name);
    const serialized = serializeMemory({ name: params.name.trim(), description, type: params.type, body });
    atomicWriteFile(fileFor(scope, params.type, slug, cwd), serialized);
    const entry: MemoryEntry = { id: slug, scope, type: params.type, name: params.name.trim(), description };
    const nextIndex = upsertEntry(state.index, entry);
    state = { index: nextIndex, projectSlug: state.projectSlug };
    writeIndex(scope, cwd, scope === 'global' ? nextIndex.global : nextIndex.project);
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // keep going
    }
    return {
      content: `Saved memory [${scope}/${params.type}] ${slug} — ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'save', state: cloneState(state), entry },
    };
  };

  const actUpdate = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'update', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    if (params.name === undefined && params.description === undefined && params.body === undefined) {
      const error = '`update` requires at least one of `name`, `description`, `body`';
      return {
        content: `Error: ${error}`,
        details: { action: 'update', state: cloneState(state), error },
        isError: true,
      };
    }
    const nextName = params.name !== undefined ? params.name.trim() : resolved.name;
    if (nextName.length === 0) {
      const error = '`name` may not be empty';
      return {
        content: `Error: ${error}`,
        details: { action: 'update', state: cloneState(state), error },
        isError: true,
      };
    }
    const nextDescription = params.description !== undefined ? params.description.trim() : resolved.description;
    // When the caller omits `body`, we preserve the on-disk body. If we can't
    // read it, refuse to clobber — rewriting the file with an empty body here
    // would silently destroy content.
    let nextBody: string;
    if (params.body !== undefined) {
      nextBody = params.body.trim();
      if (nextBody.length === 0) {
        const error = '`body` may not be empty — use `remove` to delete the memory';
        return {
          content: `Error: ${error}`,
          details: { action: 'update', state: cloneState(state), error },
          isError: true,
        };
      }
    } else {
      const existing = fileBodyFor(resolved, cwd);
      if (existing === null) {
        const error = `cannot preserve body: "${resolved.id}" is not readable on disk — pass \`body\` explicitly or re-save`;
        return {
          content: `Error: ${error}`,
          details: { action: 'update', state: cloneState(state), error },
          isError: true,
        };
      }
      nextBody = existing.trim();
      if (nextBody.length === 0) {
        const error = `existing body for "${resolved.id}" is empty — pass \`body\` explicitly`;
        return {
          content: `Error: ${error}`,
          details: { action: 'update', state: cloneState(state), error },
          isError: true,
        };
      }
    }
    const renamed = params.name !== undefined && slugifyName(params.name) !== resolved.id;
    let nextIndex = state.index;
    let nextId = resolved.id;
    if (renamed) {
      // Remove the outgoing entry from the index BEFORE picking a new slug so
      // a rename that collapses back to the same slug (or a reclaimed one)
      // doesn't get pushed to `-2`. Then remove the old file.
      nextIndex = removeEntry(nextIndex, resolved.scope, resolved.id);
      nextId = chooseSlug({ index: nextIndex, projectSlug: state.projectSlug }, resolved.scope, params.name!);
      removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, cwd));
    }
    const serialized = serializeMemory({
      name: nextName,
      description: nextDescription,
      type: resolved.type,
      body: nextBody,
    });
    atomicWriteFile(fileFor(resolved.scope, resolved.type, nextId, cwd), serialized);
    const entry: MemoryEntry = {
      id: nextId,
      scope: resolved.scope,
      type: resolved.type,
      name: nextName,
      description: nextDescription,
    };
    nextIndex = upsertEntry(nextIndex, entry);
    state = { index: nextIndex, projectSlug: state.projectSlug };
    writeIndex(entry.scope, cwd, entry.scope === 'global' ? nextIndex.global : nextIndex.project);
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // keep going
    }
    return {
      content: `Updated memory [${entry.scope}/${entry.type}] ${entry.id} — ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'update', state: cloneState(state), entry },
    };
  };

  const actRemove = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    if (!params.scope) {
      const error = '`scope` is required for `remove` (global or project)';
      return {
        content: `Error: ${error}`,
        details: { action: 'remove', state: cloneState(state), error },
        isError: true,
      };
    }
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'remove', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, cwd));
    const nextIndex = removeEntry(state.index, resolved.scope, resolved.id);
    state = { index: nextIndex, projectSlug: state.projectSlug };
    writeIndex(resolved.scope, cwd, resolved.scope === 'global' ? nextIndex.global : nextIndex.project);
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // keep going
    }
    return {
      content: `Removed memory [${resolved.scope}/${resolved.type}] ${resolved.id}\n\n${formatText(state)}`,
      details: { action: 'remove', state: cloneState(state), entry: resolved },
    };
  };

  const actSearch = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    const q = (params.query ?? '').trim();
    if (q.length === 0) {
      const error = '`query` is required for `search`';
      return {
        content: `Error: ${error}`,
        details: { action: 'search', state: cloneState(state), error },
        isError: true,
      };
    }
    const needle = q.toLowerCase();
    const matches: MemoryEntry[] = [];
    const allEntries = [...state.index.global, ...state.index.project];
    for (const e of allEntries) {
      const hay = [e.name, e.description, e.id].join(' ').toLowerCase();
      if (hay.includes(needle)) {
        matches.push(e);
        continue;
      }
      const body = fileBodyFor(e, cwd);
      if (body && body.toLowerCase().includes(needle)) matches.push(e);
    }
    if (matches.length === 0) {
      return {
        content: `No memories match "${q}".`,
        details: { action: 'search', state: cloneState(state), matches: [] },
      };
    }
    const lines = matches.map((e) => `  [${e.scope}/${e.type}] ${e.id} — ${e.name}: ${e.description}`);
    return {
      content: `Matches for "${q}" (${matches.length}):\n${lines.join('\n')}`,
      details: { action: 'search', state: cloneState(state), matches },
    };
  };

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'memory',
    label: 'Memory',
    description:
      'Persistent multi-layered memory: durable notes about the user, feedback, project, and external references that survive across sessions. Stored on disk under ~/.pi/agent/memory. Actions: list, read (id), save ({type, name, description, body, scope?}), update (id, {name?, description?, body?}), remove (id, scope), search (query).',
    promptSnippet:
      'Durable cross-session memory for user preferences, validated approaches, project decisions, and reference pointers.',
    promptGuidelines: [
      'Save a memory (`memory` action `save`) when the user corrects your approach, states a preference, validates a non-obvious choice, or references an external system. Include `type`, `name`, a 1-line `description`, and the `body`.',
      'Do NOT save memories for code patterns, git history, or ephemeral task state — read the code or `git log` instead.',
      'Default scopes: `user`/`feedback` → global (cross-project); `project`/`reference` → project (this workspace only). Override with `scope` when a user/feedback memory is workspace-specific.',
      'Before relying on a memory, verify it is still accurate — names/files can be renamed or removed since the memory was written. If stale, `update` or `remove` it.',
    ],
    parameters: MemoryParams,

    async execute(_toolCallId, params: MemoryParamsT, _signal, _onUpdate, ctx) {
      // Keep `cwd` fresh — tool calls can happen long after session_start
      // and the cwd in ctx may have changed across commands.
      if (ctx?.cwd && ctx.cwd !== cwd) {
        cwd = ctx.cwd;
      }
      let out: { content: string; details: MemoryDetails; isError?: boolean };
      switch (params.action) {
        case 'list':
          out = actList();
          break;
        case 'read':
          out = actRead(params);
          break;
        case 'save':
          out = actSave(params);
          break;
        case 'update':
          out = actUpdate(params);
          break;
        case 'remove':
          out = actRemove(params);
          break;
        case 'search':
          out = actSearch(params);
          break;
      }
      return {
        content: [{ type: 'text', text: out.content }],
        details: out.details,
        isError: out.isError,
      };
    },

    renderCall(args, theme, _context) {
      const a = args as MemoryParamsT;
      let text = theme.fg('toolTitle', theme.bold('memory ')) + theme.fg('muted', a.action);
      if (a.type) text += ` ${theme.fg('dim', a.type)}`;
      if (a.scope) text += ` ${theme.fg('dim', `(${a.scope})`)}`;
      if (a.id) text += ` ${theme.fg('accent', a.id)}`;
      if (a.name) text += ` ${theme.fg('dim', `"${truncate(a.name, 40)}"`)}`;
      if (a.query) text += ` ${theme.fg('dim', `?"${truncate(a.query, 30)}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<MemoryDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      }
      if (details.action === 'read' && details.entry && details.body !== undefined) {
        const e = details.entry;
        const header = theme.fg('muted', `[${e.scope}/${e.type}] `) + theme.fg('accent', e.id);
        const body = expanded ? details.body : truncate(details.body.trim(), 200);
        return new Text(`${header}\n${theme.fg('text', body)}`, 0, 0);
      }
      if (details.action === 'search') {
        const matches = details.matches ?? [];
        if (matches.length === 0) return new Text(theme.fg('dim', '(no matches)'), 0, 0);
        const display = expanded ? matches : matches.slice(0, 8);
        const parts: string[] = [theme.fg('muted', `${matches.length} match(es)`)];
        for (const e of display)
          parts.push(`  ${theme.fg('accent', e.id)} ${theme.fg('dim', `[${e.type}]`)} ${e.name}`);
        if (!expanded && matches.length > display.length) {
          parts.push(theme.fg('dim', `  … ${matches.length - display.length} more`));
        }
        return new Text(parts.join('\n'), 0, 0);
      }
      const s = details.state ?? emptyState();
      const global = s.index?.global ?? [];
      const project = s.index?.project ?? [];
      if (global.length === 0 && project.length === 0) {
        return new Text(theme.fg('dim', '(no memories)'), 0, 0);
      }
      const parts: string[] = [theme.fg('muted', `${global.length} global · ${project.length} project`)];
      const show = expanded ? [...global, ...project] : [...global, ...project].slice(0, 6);
      for (const e of show) {
        parts.push(
          `  ${theme.fg('accent', e.id)} ${theme.fg('dim', `[${e.scope}/${e.type}]`)} ${truncate(e.name, 60)}`,
        );
      }
      const total = global.length + project.length;
      if (!expanded && total > show.length) {
        parts.push(theme.fg('dim', `  … ${total - show.length} more`));
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /memory command ─────────────────────────────────────────────────
  pi.registerCommand('memory', {
    description: 'List memories (`list`), preview the injected index (`preview`), or print the memory dir (`dir`)',
    handler: async (args, ctx) => {
      const sub = (args ?? '').trim().toLowerCase();
      if (sub === '' || sub === 'list') {
        ctx.ui.notify(formatText(state), 'info');
        return;
      }
      if (sub === 'preview') {
        if (!autoInjectEnabled) {
          ctx.ui.notify(
            'Memory auto-injection is disabled (PI_MEMORY_DISABLE_AUTOINJECT=1). ' +
              'Nothing would be added to the system prompt next turn.\n\n' +
              formatText(state),
            'info',
          );
          return;
        }
        const block = formatMemoryIndex(state, { maxChars: maxInjectedChars });
        if (!block) {
          ctx.ui.notify("(no memories — nothing would be injected into the next turn's system prompt)", 'info');
          return;
        }
        ctx.ui.notify(
          `Injected into the next turn's system prompt (cap ${maxInjectedChars} chars, rendered ${block.length}):\n\n${block}`,
          'info',
        );
        return;
      }
      if (sub === 'dir') {
        const root = memoryRoot();
        const g = globalDir(root);
        const p = projectDir(ctx.cwd, root);
        ctx.ui.notify(`Memory root: ${root}\nGlobal:  ${g}\nProject: ${p}\nProject slug: ${cwdSlug(ctx.cwd)}`, 'info');
        return;
      }
      if (sub === 'rescan') {
        rebuildFromDisk(ctx);
        ctx.ui.notify(`Rescanned memory dirs.\n\n${formatText(state)}`, 'info');
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /memory [list|preview|dir|rescan]`, 'warning');
    },
  });
}
