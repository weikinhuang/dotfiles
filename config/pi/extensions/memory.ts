/**
 * Memory extension for pi - cross-session, multi-layered durable notes.
 *
 * Port of Claude Code's "auto memory" feature. Durable knowledge is
 * kept as small markdown files on disk and indexed by a per-scope
 * `MEMORY.md` file. Each turn the extension injects the indices into
 * the system prompt under a `## Memory` header so the model sees what
 * durable context is available without a tool call; full bodies are
 * fetched on demand via `memory read <id>`.
 *
 * Memory types:
 *   - `user`      - facts about the user (role, preferences, expertise). Cross-project by default.
 *   - `feedback`  - corrections + validated approaches (don't-do-X / keep-doing-Y). Cross-project by default.
 *   - `project`   - initiatives, decisions, incidents for *this* workspace.
 *   - `reference` - pointers to external systems (Linear projects, dashboards). Per-workspace.
 *   - `note`      - freeform working notes for *this* session only (session scope exclusive).
 *
 * Scopes:
 *   - `global`    - `<root>/global/<type>/<slug>.md`, shared across every pi session.
 *   - `project`   - `<root>/projects/<cwd-slug>/<type>/<slug>.md`, keyed on the cwd
 *                   the same way pi keys `~/.pi/agent/sessions/<cwd-slug>/`.
 *   - `session`   - `<root>/projects/<cwd-slug>/sessions/<session-id>/note/<slug>.md`, keyed on
 *                   the session id; only ever loaded for the session that owns it. Holds `note`s.
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
 *   PI_MEMORY_STALE_DAYS=N           age (days) past which a project memory
 *                                    gets a `(Nd)` marker + shows in
 *                                    `/memory stale` (default 30).
 *   PI_MEMORY_ROOT=<path>            override `~/.pi/agent/memory`.
 *   PI_MEMORY_READONLY=1             block save/update/remove; list/read/
 *                                    search + auto-inject still work.
 *   PI_MEMORY_DISABLE_CAPTURE=1      skip the capture-assist nudge (fired into
 *                                    the turn after a compaction to save
 *                                    un-saved durable facts; lists concrete
 *                                    candidates mined from the compaction
 *                                    summary when available).
 *   PI_MEMORY_CAPTURE_TURN=1         deliver the post-compaction capture
 *                                    directive as its OWN follow-up turn
 *                                    instead of a <system-reminder> riding the
 *                                    next turn. Small/weak models ignore the
 *                                    reminder but act on a dedicated turn;
 *                                    costs one extra (visible) model turn.
 */

import { readdirSync } from 'node:fs';

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  atomicWriteFile,
  chooseMemorySlug,
  fileFor,
  globalDir,
  indexFileFor,
  listSessionMemoryDirs,
  memoryRoot,
  projectDir,
  projectSlug,
  pruneOrphanSessionDirs,
  readMemoryBody,
  readMemoryFrontmatter,
  rebuildMemoryIndex,
  removeFileIfExists,
  sessionDir,
  slugifyName,
} from '../../../lib/node/pi/memory-paths.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import {
  buildCandidateNudge,
  CAPTURE_NUDGE,
  selectCaptureCandidates,
  shouldNudgeCapture,
} from '../../../lib/node/pi/memory-capture.ts';
import { formatMemoryIndex } from '../../../lib/node/pi/memory-prompt.ts';
import { validateSaveParams } from '../../../lib/node/pi/memory/save.ts';
import { MEMORY_USAGE } from '../../../lib/node/pi/memory/usage.ts';
import {
  cloneState,
  DEFAULT_STALE_DAYS,
  emptyState,
  entryAgeDays,
  formatText,
  isStaleEntry,
  MEMORY_CUSTOM_TYPE,
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
} from '../../../lib/node/pi/memory-reducer.ts';
import { findSimilarMemories, searchMemories } from '../../../lib/node/pi/memory-search.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import { envTruthy, parseClampedPositiveInt, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

const MAX_INJECTED_CHARS_DEFAULT = 3000;

// ──────────────────────────────────────────────────────────────────────
// Tool params
// ──────────────────────────────────────────────────────────────────────

const MemoryParams = Type.Object({
  action: StringEnum(['list', 'read', 'save', 'update', 'remove', 'search'] as const),
  type: Type.Optional(
    StringEnum(['user', 'feedback', 'project', 'reference', 'note'] as const, {
      description:
        'Memory type. Required for `save` (session scope defaults to `note`). For `read`/`update`/`remove`, disambiguates when an id exists in multiple types. `note` is session-only.',
    }),
  ),
  scope: Type.Optional(
    StringEnum(['global', 'project', 'session'] as const, {
      description:
        'Scope. Defaults: user/feedback → global, project/reference → project, note → session. `session` is not loaded by other sessions. Required for `remove`.',
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
// be read at a glance. Must stay in sync with `MemoryParams` - if you add
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

function bucketFor(index: MemoryIndex, scope: MemoryScope): MemoryEntry[] {
  if (scope === 'global') return index.global;
  if (scope === 'session') return index.session;
  return index.project;
}

function writeIndex(scope: MemoryScope, cwd: string, sessionId: string | null, entries: MemoryEntry[]): void {
  const md = renderMemoryMd(
    entries.filter((e) => e.scope === scope),
    scope,
  );
  atomicWriteFile(indexFileFor(scope, cwd, sessionId), md);
}

/**
 * Resolve the current session id, tolerating an absent/throwing session
 * manager (e.g. `pi --no-session`). Returns `null` when there is no
 * tracked session - session-scoped saves then surface a clear error.
 */
function readSessionId(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager?.getSessionId() ?? null;
  } catch {
    return null;
  }
}

/**
 * The set of session ids that still have a transcript for this workspace
 * - the `<sid>.jsonl` files in pi's session dir, plus the current
 * session id (which may not be flushed yet). Returns `null` when no
 * session dir is resolvable, so `gc` can refuse rather than prune
 * everything against an empty live set.
 */
function liveSessionIds(ctx: ExtensionContext): Set<string> | null {
  let dir: string | undefined;
  let current: string | undefined;
  try {
    dir = ctx.sessionManager?.getSessionDir();
    current = ctx.sessionManager?.getSessionId();
  } catch {
    return null;
  }
  if (!dir) return null;
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length));
    }
  } catch {
    // Dir unreadable - fall through to at least keep the current session.
  }
  if (current) ids.add(current);
  return ids;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function memoryExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_MEMORY_DISABLED)) return;

  const autoInjectEnabled = process.env.PI_MEMORY_DISABLE_AUTOINJECT !== '1';
  const readOnly = envTruthy(process.env.PI_MEMORY_READONLY);
  const maxInjectedChars = parseClampedPositiveInt(
    process.env.PI_MEMORY_MAX_INJECTED_CHARS,
    MAX_INJECTED_CHARS_DEFAULT,
    500,
  );
  const staleDays = parsePositiveInt(process.env.PI_MEMORY_STALE_DAYS, DEFAULT_STALE_DAYS);
  // Capture-assist: a one-shot nudge fired after compaction.
  const captureDisabled = envTruthy(process.env.PI_MEMORY_DISABLE_CAPTURE);
  const captureEnabled = !captureDisabled && !readOnly;
  // Delivery mode: by default the nudge rides the next turn as a
  // <system-reminder> (invisible, cache-cheap, works on frontier models).
  // Eval on a small self-hosted model showed it ignores reminders riding a
  // user turn (0/26) but reliably acts when the same directive is its OWN
  // turn (8/8). PI_MEMORY_CAPTURE_TURN=1 escalates to delivering the
  // candidate directive as a synthetic follow-up turn (visible + one extra
  // model call) - opt-in for small/weak models.
  const captureAsTurn = captureEnabled && envTruthy(process.env.PI_MEMORY_CAPTURE_TURN);
  // Real clock for write-time timestamps + staleness math. Pure helpers
  // take an injected `Date`; this extension supplies the live one.
  const now = (): Date => new Date();

  let state: MemoryState = emptyState();
  let cwd: string = process.cwd();
  let sessionId: string | null = null;
  // Capture-assist gating: user submits observed since the last
  // successful `memory save` this session. Incremented in
  // `before_agent_start` (one per submit), reset to 0 after a save.
  // `> 0` at compaction time means there is plausibly an unsaved
  // durable fact worth nudging about; `0` keeps the nudge quiet.
  let userTurnsSinceLastSave = 0;
  // Capture-assist: set true when compaction fires (and the nag-gate allows),
  // consumed once by the next `context` hook which splices a model-facing
  // <system-reminder> into the turn. `session_before_compact` can only
  // cancel/replace the compaction - it cannot inject context - so the nudge
  // has to ride the following turn to actually reach the model.
  let capturePending = false;
  // Concrete candidate-listing nudge body built from the compaction summary
  // in `session_compact` (Depth B). `null` => fall back to the generic
  // CAPTURE_NUDGE. Consumed + cleared with `capturePending`.
  let pendingCaptureBody: string | null = null;
  const surfacedWarnings = new Set<string>();

  const readOnlyError = (action: string): { content: string; details: MemoryDetails; isError: boolean } => {
    const error = `memory is read-only: PI_MEMORY_READONLY=1`;
    return {
      content: `Error: ${error}`,
      details: { action, state: cloneState(state), error },
      isError: true,
    };
  };

  const rebuildFromDisk = (ctx: ExtensionContext): void => {
    cwd = ctx.cwd;
    sessionId = readSessionId(ctx);
    const { state: next, warnings } = rebuildMemoryIndex(cwd, sessionId);
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

  // Count the submit for the capture-assist gate and, when enabled, inject
  // the STATIC memory index into the cached system prompt. The static index
  // only changes on save/update/remove, so it does not bust the prompt-prefix
  // cache turn-to-turn.
  pi.on('before_agent_start', (event) => {
    // Count this submit as user activity for the capture-assist gate.
    userTurnsSinceLastSave += 1;
    if (!autoInjectEnabled) return undefined;
    const block = formatMemoryIndex(state, { maxChars: maxInjectedChars, now: now(), staleDays });
    if (!block) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  // ── Capture-assist context-hook injection ────────────────────────────
  // The capture nudge rides the turn as an ephemeral <system-reminder>
  // (never the system prompt, so the KV cache prefix stays byte-stable) and
  // fires once after a compaction (see below). Nothing pending injects nothing.
  if (captureEnabled) {
    pi.on('context', (event) => {
      let messages = event.messages as unknown as ReminderMessage[];
      let changed = false;
      if (capturePending) {
        // One-shot: consume the flag whether or not we inject, so a stale
        // nudge never lingers across turns. Prefer the concrete
        // candidate-listing body (Depth B); fall back to the generic nudge.
        capturePending = false;
        const body = pendingCaptureBody ?? CAPTURE_NUDGE;
        pendingCaptureBody = null;
        messages = applyContextReminder(messages, { id: 'memory-capture', body });
        changed = true;
      }
      if (!changed) return undefined;
      return { messages: messages as unknown as typeof event.messages };
    });
  }

  // ── Capture-assist: arm a nudge when compaction happens ───────────────
  // Compaction summarizes the conversation away, taking any un-saved
  // durable fact with it. We can't inject context from
  // `session_before_compact` (its result only cancels/replaces the
  // compaction), so we arm `capturePending` here and let the next
  // `context` hook splice a model-facing reminder into the following turn.
  // Gated to avoid nag fatigue: only when there has been a user turn since
  // the last save (never when read-only or disabled).
  if (captureEnabled) {
    pi.on('session_before_compact', () => {
      if (shouldNudgeCapture({ userTurnsSinceLastSave, readOnly, disabled: captureDisabled })) {
        capturePending = true;
      }
      return undefined;
    });

    // After compaction, mine the just-generated summary for concrete
    // save-worthy candidates (free - the summarizer already extracted them
    // into its Constraints & Preferences / Key Decisions sections) and drop
    // any already saved. The summary work is wrapped so a parse error never
    // breaks compaction.
    pi.on('session_compact', (event) => {
      if (!capturePending) return undefined;
      let body: string | null = null;
      try {
        const summary = event.compactionEntry.summary;
        const allEntries = [...state.index.global, ...state.index.project, ...state.index.session];
        const isAlreadySaved = (text: string): boolean =>
          findSimilarMemories({ name: text, description: text, body: text }, allEntries, (e) =>
            readMemoryBody(e, cwd, sessionId),
          ).length > 0;
        body = buildCandidateNudge(selectCaptureCandidates(summary, isAlreadySaved));
      } catch {
        body = null;
      }
      // PI_MEMORY_CAPTURE_TURN: deliver the concrete directive as its OWN
      // follow-up turn (the model treats the save as its primary task -
      // 8/8 on a small model vs 0/26 for a reminder riding a user turn).
      // Only when we actually have candidates; otherwise leave the generic
      // reminder path armed. A vague "save something" turn is not worth a
      // synthetic turn + model call.
      if (captureAsTurn && body) {
        capturePending = false;
        pendingCaptureBody = null;
        pi.sendUserMessage(body, { deliverAs: 'followUp' });
      } else {
        // Reminder path (default): stash the concrete body for the context
        // hook; `null` falls back to the generic CAPTURE_NUDGE.
        pendingCaptureBody = body;
      }
      return undefined;
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
    const resolved = resolveMemoryEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'read', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    const body = readMemoryBody(resolved, cwd, sessionId);
    if (body == null) {
      const error = `memory "${resolved.id}" not readable on disk`;
      return {
        content: `Error: ${error}`,
        details: { action: 'read', state: cloneState(state), error },
        isError: true,
      };
    }
    const header = `[${resolved.scope}/${resolved.type}] ${resolved.id} - ${resolved.name}\n${resolved.description}\n`;
    return {
      content: `${header}\n${body.trim()}\n`,
      details: { action: 'read', state: cloneState(state), entry: { ...resolved }, body },
    };
  };

  const actSave = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    if (readOnly) return readOnlyError('save');
    const validated = validateSaveParams(params, sessionId);
    if (!validated.ok) {
      return {
        content: validated.content,
        details: { action: 'save', state: cloneState(state), error: validated.error },
        isError: true,
      };
    }
    const { type, scope, name, description, body } = validated;
    // Non-blocking duplicate check, scoped to the same scope+type.
    // (Secret-shaped content is gated upstream by the secret-redactor
    // extension's tool-arg guard, so memory never needs its own check.)
    const similar = findSimilarMemories(
      { name, description, body },
      bucketFor(state.index, scope).filter((e) => e.type === type),
      (e) => readMemoryBody(e, cwd, sessionId),
    );
    const warnings: string[] = [];
    if (similar.length > 0) {
      const ids = similar.map((s) => `\`${s.entry.id}\` ([${s.entry.type}])`).join(', ');
      warnings.push(
        `Note: this looks similar to existing memory ${ids}. Consider \`update\`-ing instead of saving a duplicate.`,
      );
    }
    const slug = chooseMemorySlug(state, scope, name);
    // New memory: stamp both timestamps with the same instant.
    const stamp = now().toISOString();
    const serialized = serializeMemory({
      name,
      description,
      type,
      body,
      created: stamp,
      updated: stamp,
    });
    atomicWriteFile(fileFor(scope, type, slug, cwd, sessionId), serialized);
    const entry: MemoryEntry = {
      id: slug,
      scope,
      type,
      name,
      description,
      created: stamp,
      updated: stamp,
    };
    const nextIndex = upsertEntry(state.index, entry);
    state = { index: nextIndex, projectSlug: state.projectSlug, sessionId: state.sessionId };
    writeIndex(scope, cwd, sessionId, bucketFor(nextIndex, scope));
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // keep going
    }
    // A successful save clears the capture-assist gate: nothing fresh is
    // unsaved until the next user turn.
    userTurnsSinceLastSave = 0;
    const prefix = warnings.length > 0 ? `${warnings.join('\n')}\n\n` : '';
    return {
      content: `${prefix}Saved memory [${scope}/${type}] ${slug} - ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'save', state: cloneState(state), entry },
    };
  };

  const actUpdate = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    if (readOnly) return readOnlyError('update');
    const resolved = resolveMemoryEntry(state, params);
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
    // read it, refuse to clobber - rewriting the file with an empty body here
    // would silently destroy content.
    let nextBody: string;
    if (params.body !== undefined) {
      nextBody = params.body.trim();
      if (nextBody.length === 0) {
        const error = '`body` may not be empty - use `remove` to delete the memory';
        return {
          content: `Error: ${error}`,
          details: { action: 'update', state: cloneState(state), error },
          isError: true,
        };
      }
    } else {
      const existing = readMemoryBody(resolved, cwd, sessionId);
      if (existing === null) {
        const error = `cannot preserve body: "${resolved.id}" is not readable on disk - pass \`body\` explicitly or re-save`;
        return {
          content: `Error: ${error}`,
          details: { action: 'update', state: cloneState(state), error },
          isError: true,
        };
      }
      nextBody = existing.trim();
      if (nextBody.length === 0) {
        const error = `existing body for "${resolved.id}" is empty - pass \`body\` explicitly`;
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
      nextId = chooseMemorySlug(
        { index: nextIndex, projectSlug: state.projectSlug, sessionId: state.sessionId },
        resolved.scope,
        params.name!,
      );
      removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, cwd, sessionId));
    }
    // Preserve `created`, bumping `updated` to now. Prefer the resolved
    // entry's own `created` (populated by the disk scan and captured before
    // any rename removed the old file); fall back to re-reading the
    // on-disk frontmatter for entries indexed before timestamps existed.
    // The rename path carries `created` across automatically via this value.
    const priorCreated = resolved.created ?? readMemoryFrontmatter(resolved, cwd, sessionId)?.created;
    const updatedStamp = now().toISOString();
    const serialized = serializeMemory({
      name: nextName,
      description: nextDescription,
      type: resolved.type,
      body: nextBody,
      created: priorCreated,
      updated: updatedStamp,
    });
    atomicWriteFile(fileFor(resolved.scope, resolved.type, nextId, cwd, sessionId), serialized);
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
    state = { index: nextIndex, projectSlug: state.projectSlug, sessionId: state.sessionId };
    writeIndex(entry.scope, cwd, sessionId, bucketFor(nextIndex, entry.scope));
    try {
      pi.appendEntry(MEMORY_CUSTOM_TYPE, cloneState(state));
    } catch {
      // keep going
    }
    return {
      content: `Updated memory [${entry.scope}/${entry.type}] ${entry.id} - ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'update', state: cloneState(state), entry },
    };
  };

  const actRemove = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    if (readOnly) return readOnlyError('remove');
    if (!params.scope) {
      const error = '`scope` is required for `remove` (global, project, or session)';
      return {
        content: `Error: ${error}`,
        details: { action: 'remove', state: cloneState(state), error },
        isError: true,
      };
    }
    const resolved = resolveMemoryEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'remove', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    removeFileIfExists(fileFor(resolved.scope, resolved.type, resolved.id, cwd, sessionId));
    const nextIndex = removeEntry(state.index, resolved.scope, resolved.id);
    state = { index: nextIndex, projectSlug: state.projectSlug, sessionId: state.sessionId };
    writeIndex(resolved.scope, cwd, sessionId, bucketFor(nextIndex, resolved.scope));
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
    const allEntries = [...state.index.global, ...state.index.project, ...state.index.session];
    const matches = searchMemories(allEntries, (e) => readMemoryBody(e, cwd, sessionId), q).map((s) => s.entry);
    if (matches.length === 0) {
      return {
        content: `No memories match "${q}".`,
        details: { action: 'search', state: cloneState(state), matches: [] },
      };
    }
    const lines = matches.map((e) => `  [${e.scope}/${e.type}] ${e.id} - ${e.name}: ${e.description}`);
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
      'Persistent multi-layered memory: durable notes about the user, feedback, project, and external references that survive across sessions, plus session-scoped `note`s for the current session only. Stored on disk under ~/.pi/agent/memory. Actions: list, read (id), save ({type, name, description, body, scope?}), update (id, {name?, description?, body?}), remove (id, scope), search (query).',
    promptSnippet:
      'Durable cross-session memory for user preferences, validated approaches, project decisions, and reference pointers, plus per-session working notes.',
    promptGuidelines: [
      'Save a memory (`memory` action `save`) when the user corrects your approach, states a preference, validates a non-obvious choice, or references an external system. Include `type`, `name`, a 1-line `description`, and the `body`.',
      'Do NOT save memories for code patterns, git history, or ephemeral task state - read the code or `git log` instead.',
      'Default scopes: `user`/`feedback` → global (cross-project); `project`/`reference` → project (this workspace only); `note` → session (this session only). Override with `scope` when a user/feedback memory is workspace-specific.',
      'Use `scope: session` (type `note`) for working context that matters only within this session - it is not loaded by any other session. Use `project` for facts that should outlive the session.',
      'Before relying on a memory, verify it is still accurate - names/files can be renamed or removed since the memory was written. If stale, `update` or `remove` it.',
    ],
    parameters: MemoryParams,

    async execute(_toolCallId, params: MemoryParamsT, _signal, _onUpdate, ctx) {
      // Keep `cwd`/`sessionId` fresh - tool calls can happen long after
      // session_start and the cwd/session in ctx may have changed across
      // commands.
      if (ctx?.cwd && ctx.cwd !== cwd) {
        cwd = ctx.cwd;
      }
      if (ctx) {
        const sid = readSessionId(ctx);
        if (sid) sessionId = sid;
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
      const a = args;
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
      const session = s.index?.session ?? [];
      if (global.length === 0 && project.length === 0 && session.length === 0) {
        return new Text(theme.fg('dim', '(no memories)'), 0, 0);
      }
      const parts: string[] = [
        theme.fg('muted', `${global.length} global · ${project.length} project · ${session.length} session`),
      ];
      const all = [...global, ...project, ...session];
      const show = expanded ? all : all.slice(0, 6);
      for (const e of show) {
        parts.push(
          `  ${theme.fg('accent', e.id)} ${theme.fg('dim', `[${e.scope}/${e.type}]`)} ${truncate(e.name, 60)}`,
        );
      }
      const total = all.length;
      if (!expanded && total > show.length) {
        parts.push(theme.fg('dim', `  … ${total - show.length} more`));
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /memory command ─────────────────────────────────────────────────
  pi.registerCommand('memory', {
    description: 'Inspect or maintain durable cross-session memory',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        list: { description: 'List loaded memories' },
        preview: { description: 'Preview the injected memory index' },
        dir: { description: 'Print the memory directory path' },
        rescan: { description: 'Rescan the memory directory from disk' },
        stale: { description: 'List project memories older than the stale threshold' },
        gc: { description: 'Prune orphaned session memory' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(MEMORY_USAGE, 'info');
        return;
      }
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
        const block = formatMemoryIndex(state, { maxChars: maxInjectedChars, now: now(), staleDays });
        if (!block) {
          ctx.ui.notify("(no memories - nothing would be injected into the next turn's system prompt)", 'info');
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
        const sid = readSessionId(ctx);
        const sessionLine = sid ? sessionDir(ctx.cwd, sid, root) : '(no active session)';
        const slug = projectSlug(ctx.cwd);
        const slugSource = process.env.PI_MEMORY_PROJECT_SLUG?.trim() ? ' (PI_MEMORY_PROJECT_SLUG)' : '';
        ctx.ui.notify(
          `Memory root: ${root}\nGlobal:  ${g}\nProject: ${p}\nSession: ${sessionLine}\nProject slug: ${slug}${slugSource}\nSession id: ${sid ?? '(none)'}`,
          'info',
        );
        return;
      }
      if (sub === 'rescan') {
        rebuildFromDisk(ctx);
        ctx.ui.notify(`Rescanned memory dirs.\n\n${formatText(state)}`, 'info');
        return;
      }
      if (sub === 'stale') {
        const at = now();
        const stale = state.index.project
          .filter((e) => isStaleEntry(e, at, staleDays))
          .map((e) => ({ entry: e, age: entryAgeDays(e, at) ?? 0 }))
          .sort((a, b) => b.age - a.age); // oldest first
        if (stale.length === 0) {
          ctx.ui.notify(
            `No project memories older than ${staleDays}d (PI_MEMORY_STALE_DAYS). Project memories decay fast - review periodically.`,
            'info',
          );
          return;
        }
        const lines = stale.map(({ entry, age }) => `  ${entry.id} (${age}d) - ${entry.name}: ${entry.description}`);
        ctx.ui.notify(
          `${stale.length} stale project memory(ies) older than ${staleDays}d (oldest first). ` +
            `Review and \`update\` or \`remove\` as needed:\n${lines.join('\n')}`,
          'info',
        );
        return;
      }
      if (sub === 'gc') {
        const live = liveSessionIds(ctx);
        if (live === null) {
          ctx.ui.notify(
            'Cannot gc session memory: no session dir resolved (running pi with --no-session?). ' +
              'Refusing to prune without a live-session set to compare against.',
            'warning',
          );
          return;
        }
        const before = listSessionMemoryDirs(ctx.cwd);
        const removed = pruneOrphanSessionDirs(ctx.cwd, live);
        rebuildFromDisk(ctx);
        ctx.ui.notify(
          removed.length === 0
            ? `No orphaned session memory to prune (${before.length} session dir(s) all have transcripts).`
            : `Pruned ${removed.length} orphaned session memory dir(s):\n${removed.map((id) => `  ${id}`).join('\n')}`,
          'info',
        );
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /memory [list|preview|dir|rescan|stale|gc]`, 'warning');
    },
  });
}
