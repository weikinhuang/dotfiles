/**
 * Memory extension for pi - cross-session, multi-layered durable notes.
 *
 * Port of Claude Code's "auto memory" feature. Durable knowledge is
 * kept as small markdown files on disk and indexed by a per-scope
 * `MEMORY.md` file. The extension delivers the index as a cache-safe
 * `memory-index` reminder snapshot: the full `## Memory` block once (new
 * session, or after a compaction), then only a small delta when the index
 * changes, and nothing otherwise. Full bodies are fetched on demand via
 * `memory read <id>`.
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
 * Disk is the source of truth. The extension rescans the memory
 * directories on `session_start` / `session_tree`, at the start of every
 * agent run, and before every tool action, so writes from other pi
 * sessions are picked up; new files are claimed with an exclusive create
 * so concurrent saves never overwrite each other (updates of the same
 * memory are last-writer-wins). Tool writes go straight to
 * disk, then re-emit the MEMORY.md index file. The delivered-index
 * baseline is persisted as a tiny `memory-delivery` branch entry so
 * resume and `/tree` know what the model has already seen.
 *
 * Pure logic lives in `../../../lib/node/pi/memory-*.ts` so it can be
 * unit-tested under `vitest` without the pi runtime; this file holds
 * only the pi-coupled glue + disk I/O.
 *
 * Environment:
 *   PI_MEMORY_DISABLED=1             skip the extension entirely.
 *   PI_MEMORY_DISABLE_AUTOINJECT=1   tool still works but skip the
 *                                    memory-index reminder.
 *   PI_MEMORY_MAX_INJECTED_CHARS=N   soft cap on the full index (default 6000).
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

import { StringEnum } from '../../../lib/node/pi/ext/string-enum.ts';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  globalDir,
  listSessionMemoryDirs,
  memoryRoot,
  projectDir,
  projectSlug,
  pruneOrphanSessionDirs,
  readMemoryBody,
  rebuildMemoryIndex,
  sessionDir,
} from '../../../lib/node/pi/memory-paths.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import {
  applyContextReminder,
  contextRemindersEnabled,
  type ReminderMessage,
} from '../../../lib/node/pi/context-reminder.ts';
import { REMINDER_PROJECTED, type ReminderSnapshot } from '../../../lib/node/pi/reminder-lifecycle.ts';
import {
  buildCandidateNudge,
  CAPTURE_NUDGE,
  selectCaptureCandidates,
  shouldNudgeCapture,
} from '../../../lib/node/pi/memory-capture.ts';
import { DEFAULT_MAX_INDEX_CHARS, MIN_INDEX_CHARS, renderMemoryIndex } from '../../../lib/node/pi/memory-prompt.ts';
import {
  containsFullIndex,
  deliveryFromBranch,
  deliveryRecord,
  MEMORY_DELIVERY_TYPE,
  MEMORY_REMINDER_ID,
  type MemoryBaseline,
  planMemoryReminder,
  type PlannedMemoryReminder,
  type RenderedFullIndex,
  withEntry,
  withoutEntry,
} from '../../../lib/node/pi/memory/delivery.ts';
import { runMemoryAction } from '../../../lib/node/pi/memory/actions.ts';
import { MEMORY_USAGE } from '../../../lib/node/pi/memory/usage.ts';
import {
  cloneState,
  DEFAULT_STALE_DAYS,
  emptyState,
  entryAgeDays,
  formatText,
  isStaleEntry,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
} from '../../../lib/node/pi/memory-reducer.ts';
import { findSimilarMemories } from '../../../lib/node/pi/memory-search.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import { envTruthy, parseClampedPositiveInt, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

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

  const remindersEnabled = contextRemindersEnabled(process.env);
  const autoInjectEnabled = process.env.PI_MEMORY_DISABLE_AUTOINJECT !== '1' && remindersEnabled;
  const readOnly = envTruthy(process.env.PI_MEMORY_READONLY);
  const maxInjectedChars = parseClampedPositiveInt(
    process.env.PI_MEMORY_MAX_INJECTED_CHARS,
    DEFAULT_MAX_INDEX_CHARS,
    MIN_INDEX_CHARS,
  );
  const staleDays = parsePositiveInt(process.env.PI_MEMORY_STALE_DAYS, DEFAULT_STALE_DAYS);
  // Capture-assist: a one-shot nudge fired after compaction.
  const captureDisabled = envTruthy(process.env.PI_MEMORY_DISABLE_CAPTURE);
  const captureEnabled =
    !captureDisabled && !readOnly && (remindersEnabled || envTruthy(process.env.PI_MEMORY_CAPTURE_TURN));
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
  // consumed only when an eligible user-run snapshot captures the model-facing
  // <system-reminder> into the turn. `session_before_compact` can only
  // cancel/replace the compaction - it cannot inject context - so the nudge
  // has to ride the following turn to actually reach the model.
  let capturePending = false;
  // Concrete candidate-listing nudge body built from the compaction summary
  // in `session_compact` (Depth B). `null` => fall back to the generic
  // CAPTURE_NUDGE. Consumed + cleared with `capturePending`.
  let pendingCaptureBody: string | null = null;
  let captureGeneration = 0;
  let renderedCaptureGeneration: number | null = null;
  let captureEligible = false;
  const surfacedWarnings = new Set<string>();
  // Cache-safe index delivery (see lib/node/pi/memory/delivery.ts).
  // `delivered` is the baseline the model has already seen; `null` means
  // nothing is in context yet, so the next run carries the full index.
  // `pendingIndex` is what the latest `context` call proposed; it becomes
  // `delivered` only once the coordinator confirms the capture.
  let delivered: MemoryBaseline | null = null;
  let pendingIndex: PlannedMemoryReminder | null = null;

  const renderFullIndex = (): RenderedFullIndex | null => {
    const rendered = renderMemoryIndex(state, { maxChars: maxInjectedChars, now: now(), staleDays });
    return rendered ? { body: rendered.body, truncated: rendered.skipped > 0 } : null;
  };

  /**
   * Re-read every scope from disk. Cheap (a few dozen small files), and
   * run before each agent run and tool action so writes from other pi
   * sessions are seen and MEMORY.md / slug choice never work from a stale index. Changes it
   * discovers reach the model as a delta on the next run.
   */
  const rescan = (ctx: ExtensionContext | undefined): void => {
    if (ctx?.cwd) cwd = ctx.cwd;
    if (ctx) sessionId = readSessionId(ctx) ?? sessionId;
    const { state: next, warnings } = rebuildMemoryIndex(cwd, sessionId);
    state = next;
    for (const w of warnings) {
      if (surfacedWarnings.has(w)) continue;
      surfacedWarnings.add(w);
      ctx?.ui.notify(`memory: ${w}`, 'warning');
    }
  };

  // Other extensions can change this session's files after our pre-run rescan.
  const unsubscribeChanges = pi.events.on('memory:changed', (data) => {
    const change = data as { cwd?: unknown; sessionId?: unknown } | undefined;
    if (change?.cwd !== cwd || change?.sessionId !== sessionId) return;
    delivered = null;
    pendingIndex = null;
    try {
      rescan(undefined);
    } catch {
      // The normal pre-run rescan retries transient disk failures.
    }
  });
  pi.on('session_shutdown', () => unsubscribeChanges());

  /** Persist the delivered baseline so resume / `/tree` can reconstruct it. */
  const recordDelivery = (baseline: MemoryBaseline): void => {
    delivered = baseline;
    try {
      pi.appendEntry(MEMORY_DELIVERY_TYPE, deliveryRecord(baseline));
    } catch {
      // Bookkeeping must never break a turn; worst case the next run resends.
    }
  };

  /** The model learned about its own write from the tool result - no delta needed. */
  const noteLocalUpsert = (entry: MemoryEntry, replaced?: MemoryEntry): void => {
    if (delivered === null) return;
    const base = replaced ? withoutEntry(delivered.fingerprint, replaced) : delivered.fingerprint;
    recordDelivery({ fingerprint: withEntry(base, entry), truncated: delivered.truncated });
  };
  const noteLocalRemoval = (entry: MemoryEntry): void => {
    if (delivered === null) return;
    recordDelivery({ fingerprint: withoutEntry(delivered.fingerprint, entry), truncated: delivered.truncated });
  };

  const resetSession = (ctx: ExtensionContext): void => {
    cwd = ctx.cwd;
    sessionId = readSessionId(ctx);
    rescan(ctx);
    pendingIndex = null;
    try {
      delivered = deliveryFromBranch(ctx.sessionManager.getBranch());
    } catch {
      delivered = null;
    }
  };

  const resetCaptureState = (): void => {
    userTurnsSinceLastSave = 0;
    capturePending = false;
    pendingCaptureBody = null;
    renderedCaptureGeneration = null;
    captureEligible = false;
    captureGeneration += 1;
  };
  pi.on('session_start', (_event, ctx) => {
    resetCaptureState();
    resetSession(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    resetCaptureState();
    resetSession(ctx);
  });

  // Compaction may evict the snapshot that carried the full index; resend it.
  pi.on('session_compact', () => {
    delivered = null;
    pendingIndex = null;
  });

  // Refresh from disk and count activity here. The index never rebuilds the
  // leading system prompt.
  pi.on('before_agent_start', (event, ctx) => {
    try {
      rescan(ctx);
    } catch {
      // A transient disk error keeps the previous index.
    }
    captureEligible = event.messageType === 'user';
    renderedCaptureGeneration = null;
    if (!captureEligible) return;
    // Count this submit as user activity for the capture-assist gate.
    userTurnsSinceLastSave += 1;
  });
  // The snapshot coordinator captures this once per run into a distinct,
  // persisted history item. Emit the full index only when the model has no
  // baseline, a delta when the index changed, and nothing otherwise, so
  // runs do not stack identical copies of the index.
  pi.on('context', (event) => {
    if (!autoInjectEnabled) return undefined;
    pendingIndex = planMemoryReminder(delivered, state.index, renderFullIndex);
    if (!pendingIndex) return undefined;
    const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
      id: MEMORY_REMINDER_ID,
      body: pendingIndex.body,
    });
    return { messages: messages as unknown as typeof event.messages };
  });

  // Advance the delivered baseline only when the coordinator actually
  // captured the proposed body, so an aborted request never desyncs it.
  if (autoInjectEnabled) {
    const unsubscribeIndex = pi.events.on('cache-reminders:captured', (data) => {
      const snapshot = data as ReminderSnapshot | undefined;
      const planned = pendingIndex;
      if (!planned) return;
      const captured = snapshot?.specs.some(
        (spec) => spec.id === MEMORY_REMINDER_ID && spec.body === planned.body.trim(),
      );
      if (!captured) return;
      pendingIndex = null;
      recordDelivery(planned.baseline);
    });
    // Compaction is not the only way history shrinks: a rolling context
    // window (roleplay) can cut the turn whose snapshot held the full index.
    // If the final projected request no longer carries one, drop the
    // baseline so the next run resends the full index at its own origin.
    const unsubscribeProjected = pi.events.on(REMINDER_PROJECTED, (data) => {
      if (delivered === null) return;
      const messages = (data as { messages?: unknown } | undefined)?.messages;
      if (!Array.isArray(messages) || containsFullIndex(messages)) return;
      delivered = null;
    });
    pi.on('session_shutdown', () => {
      unsubscribeIndex();
      unsubscribeProjected();
    });
  }

  // ── Capture-assist context-hook injection ────────────────────────────
  // The capture nudge rides the turn as an ephemeral <system-reminder>
  // (never the system prompt, so the KV cache prefix stays byte-stable) and
  // fires once after a compaction (see below). Nothing pending injects nothing.
  if (captureEnabled && remindersEnabled) {
    const unsubscribeCapture = pi.events.on('cache-reminders:captured', (data) => {
      const snapshot = data as ReminderSnapshot | undefined;
      if (
        capturePending &&
        renderedCaptureGeneration === captureGeneration &&
        snapshot?.specs.some(
          (spec) => spec.id === 'memory-capture' && spec.body === (pendingCaptureBody ?? CAPTURE_NUDGE).trim(),
        )
      ) {
        capturePending = false;
        pendingCaptureBody = null;
        renderedCaptureGeneration = null;
      }
    });
    pi.on('session_shutdown', () => unsubscribeCapture());
    pi.on('context', (event) => {
      let messages = event.messages as unknown as ReminderMessage[];
      let changed = false;
      if (capturePending && captureEligible) {
        // A post-compaction tool request may discard fresh producer blocks.
        // Keep the one-shot pending until an eligible input snapshot captures it.
        renderedCaptureGeneration = captureGeneration;
        const body = pendingCaptureBody ?? CAPTURE_NUDGE;
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
        captureGeneration += 1;
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
      } else if (!remindersEnabled) {
        // Turn-only mode with no concrete candidates and no reminder
        // transport: nothing can deliver the generic nudge, so disarm.
        capturePending = false;
        pendingCaptureBody = null;
      } else {
        // Reminder path (default): stash the concrete body for the context
        // hook; `null` falls back to the generic CAPTURE_NUDGE.
        pendingCaptureBody = body;
      }
      return undefined;
    });
  }

  // ── Actions (shared with the opencode memory plugin) ─────────────────

  const runAction = (params: MemoryParamsT): { content: string; details: MemoryDetails; isError?: boolean } => {
    const result = runMemoryAction(state, params, {
      cwd,
      sessionId,
      root: memoryRoot(),
      now,
      ...(readOnly ? { readOnlyReason: 'PI_MEMORY_READONLY=1' } : {}),
    });
    state = result.state;
    const change = result.change;
    if (change?.kind === 'upsert') noteLocalUpsert(change.entry, change.replaced);
    if (change?.kind === 'remove') noteLocalRemoval(change.entry);
    // A successful save clears the capture-assist gate: nothing fresh is
    // unsaved until the next user turn.
    if (params.action === 'save' && change) resetCaptureState();
    const details: MemoryDetails = { action: params.action, state: cloneState(state) };
    if (result.entry) details.entry = result.entry;
    if (result.matches) details.matches = result.matches;
    if (result.body !== undefined) details.body = result.body;
    if (result.error !== undefined) details.error = result.error;
    return { content: result.content, details, ...(result.isError ? { isError: true } : {}) };
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
      // Rescan before every action: picks up the current cwd/session and
      // any memory written by another pi session, so `read` finds it and a
      // write never rebuilds MEMORY.md or picks a slug from a stale index.
      rescan(ctx);
      const out = runAction(params);
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
            'Memory auto-injection is disabled (PI_MEMORY_DISABLE_AUTOINJECT=1 or PI_CACHE_REMINDERS_DISABLED=1). ' +
              'No memory-index snapshot would be emitted next run.\n\n' +
              formatText(state),
            'info',
          );
          return;
        }
        rescan(ctx);
        const plan = planMemoryReminder(delivered, state.index, renderFullIndex);
        if (plan) {
          ctx.ui.notify(
            `Proposed ${plan.kind === 'full' ? 'full index' : 'delta'} for the next run's reminder snapshot ` +
              `(cap ${maxInjectedChars} chars, rendered ${plan.body.length}):\n\n${plan.body}`,
            'info',
          );
          return;
        }
        const full = renderFullIndex()?.body;
        ctx.ui.notify(
          full
            ? `Index unchanged since it was last delivered - nothing would be emitted next run.\n` +
                `Full index (resent after compaction or in a new session, ${full.length} chars):\n\n${full}`
            : '(no memories - no memory-index snapshot would be emitted next run)',
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
        rescan(ctx);
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
        rescan(ctx);
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
