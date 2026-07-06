/**
 * Todo extension for pi - plan-driven tracking for multi-step work.
 *
 * Ships a `todo` tool + `/todos` command plus three weak-model affordances
 * on top of pi's stock todo example (examples/extensions/todo.ts):
 *
 *   1. Richer state model: { pending | in_progress | completed | blocked }.
 *      Hard invariant: at most one `in_progress` at a time (`actStart`
 *      returns an error otherwise). Serial focus is the behavior weaker
 *      models need trained into them - silently allowing parallel work
 *      produces drift-prone plans.
 *
 *   2. Active-plan auto-injection (`context` hook). A lean snapshot of the
 *      active set (in_progress + review + pending + blocked) is spliced as
 *      an ephemeral `<system-reminder id="todo-plan">` into the last
 *      user/toolResult turn every request, via `applyContextReminder`
 *      (lib/node/pi/context-reminder.ts). This is the single most valuable
 *      affordance for weaker models: the plan stays visible across
 *      compactions and long contexts without the model having to call
 *      `list`. Injecting via the `context` hook (not the system prompt)
 *      keeps the system-prompt prefix byte-stable, so the provider's
 *      prompt cache survives plan mutations - and pi's `context` output is
 *      never persisted, so nothing accumulates and completed/cancelled
 *      items (and an empty plan) inject nothing at all.
 *
 *   3. Completion-claim guardrail (`agent_end`). If the assistant signs
 *      off as "done" while in_progress / pending items still exist, we
 *      inject a follow-up user message nudging it to finish or `block`
 *      the open items. Idempotent: the steer carries a sentinel marker,
 *      and we don't re-fire if the previous user message already bore
 *      that marker, so the loop terminates even if the model ignores it.
 *
 * State persistence is branch-aware: the `execute()` handler returns the
 * post-action state in `toolResult.details` (so /fork and /tree navigation
 * automatically show the correct state for that point in history), and
 * also mirrors it via `pi.appendEntry('todo-state', state)` so the list
 * survives /compact even when old tool-result messages are summarized
 * away. The reducer in `./lib/todo-reducer.ts` accepts either kind of
 * entry and picks the most recent one on the branch.
 *
 * Pure logic (state transitions, invariants, prompt rendering, claim
 * detection) lives in `./lib/todo-reducer.ts` and `./lib/todo-prompt.ts`
 * so it can be unit-tested under `vitest` without pulling in
 * the pi runtime. This file holds only the pi-coupled glue.
 *
 * The companion `plan-first` skill (config/pi/skills/plan-first/SKILL.md)
 * teaches models WHEN to call this tool; the extension provides the
 * mechanism, the skill provides the policy.
 *
 * Environment:
 *   PI_TODO_DISABLED=1            skip the extension entirely
 *   PI_TODO_DISABLE_AUTOINJECT=1  tool still works but skip the active-plan
 *                                 `context`-hook injection
 *   PI_TODO_DISABLE_GUARDRAIL=1   don't fire the agent_end "you claimed
 *                                 done but items are still open" steer
 *   PI_TODO_MAX_INJECTED=N        cap on pending items rendered in the
 *                                 injected block (default 10)
 */

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, Text, truncateToWidth, type TUI } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { extractLastAssistantText } from '../../../lib/node/pi/message-extract.ts';
import { TODOS_USAGE } from '../../../lib/node/pi/todo/usage.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import { assembleWindowedBody, overlayViewportRows } from '../../../lib/node/pi/ext/overlay-window.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import { formatActivePlan, looksLikeCompletionClaim } from '../../../lib/node/pi/todo-prompt.ts';
import {
  type BranchEntry as VerifyBranchEntry,
  lastUserMessageHasMarker as branchLastUserMessageHasMarker,
} from '../../../lib/node/pi/verify-detect.ts';
import { formatText, formatTodoProgress, groupTodos, transitionGlyphs } from '../../../lib/node/pi/todo-format.ts';
import {
  actAdd,
  actBlock,
  actCancel,
  actClear,
  actComplete,
  actList,
  actReopen,
  actReview,
  actStart,
  type ActionResult,
  type BranchEntry,
  cloneState,
  emptyState,
  reduceBranch,
  TODO_CUSTOM_TYPE,
  type Todo,
  type TodoState,
} from '../../../lib/node/pi/todo-reducer.ts';
import { formatHeaderRule } from '../../../lib/node/pi/tui-rule.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

// Sentinel prepended to the guardrail steer. We detect it on the most
// recent user message to make the guardrail idempotent across re-fires
// within a single turn (model ignores the steer and claims done again).
const GUARDRAIL_MARKER = '⚠ [pi-todo-guardrail]';
const GUARDRAIL_CUSTOM_TYPE = 'todo-guardrail-nudge';
const MAX_INJECTED_DEFAULT = 10;

const TodoParams = Type.Object({
  action: StringEnum(['list', 'add', 'start', 'review', 'complete', 'block', 'cancel', 'reopen', 'clear'] as const),
  text: Type.Optional(Type.String({ description: 'Todo text (for action "add")' })),
  items: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Multiple todo texts to add at once. Use this for the initial plan.',
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: 'Todo ID (for actions "start", "review", "complete", "block", "cancel", "reopen")',
    }),
  ),
  note: Type.Optional(
    Type.String({
      description:
        'Free-form note. REQUIRED for "block" (what external dependency is being waited on), for "cancel" (why the item is no longer in scope), and for "complete" when coming directly from in_progress (what verified the outcome). Optional elsewhere.',
    }),
  ),
});

interface TodoDetails extends TodoState {
  action: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Themed status glyph for a todo. Single source of truth for the
 * symbol set; mirrors `statusGlyph` in `todo-reducer.ts` but applies
 * the per-status theme colour. */
function renderStatusGlyph(status: Todo['status'], theme: Theme): string {
  switch (status) {
    case 'completed':
      return theme.fg('success', '✓');
    case 'in_progress':
      return theme.fg('accent', theme.bold('→'));
    case 'review':
      return theme.fg('warning', '⋯');
    case 'blocked':
      return theme.fg('error', '⛔');
    case 'cancelled':
      return theme.fg('muted', '⊘');
    case 'pending':
      return theme.fg('dim', '○');
  }
}

/** Single-line item render used by the inline `renderResult` grouped
 * sections. Notes are inline-parenthetical so each item is one row. */
function renderInlineTodo(t: Todo, theme: Theme, idPad: number): string {
  const glyph = renderStatusGlyph(t.status, theme);
  const idStr = `#${t.id}`.padEnd(idPad);
  const textStyled =
    t.status === 'completed' || t.status === 'cancelled' ? theme.fg('dim', t.text) : theme.fg('text', t.text);
  const note = t.note ? `  ${theme.fg('dim', `(${t.note})`)}` : '';
  return `  ${glyph} ${theme.fg('accent', idStr)} ${textStyled}${note}`;
}

/** Item render used inside the `/todos` overlay. Notes go on a
 * continuation line prefixed `• ` (overlay rows are 2-line items when
 * the note is set). */
function renderOverlayTodoLines(t: Todo, theme: Theme, idPad: number): string[] {
  const glyph = renderStatusGlyph(t.status, theme);
  const idStr = `#${t.id}`.padEnd(idPad);
  const textStyled =
    t.status === 'completed' || t.status === 'cancelled' ? theme.fg('dim', t.text) : theme.fg('text', t.text);
  const head = `    ${glyph} ${theme.fg('accent', idStr)} ${textStyled}`;
  if (!t.note) return [head];
  // Continuation indent: 4 (item indent) + 1 (glyph) + 1 (space) + idPad + 1 (space) = 7 + idPad
  const cont = `${' '.repeat(7 + idPad)}${theme.fg('dim', `• ${t.note}`)}`;
  return [head, cont];
}

/**
 * Ordered list of the six groups in their display order.
 * `withCount` controls whether the section header carries `(N)` (only
 * `Cancelled` and `Completed` do; the active groups are short enough
 * that the count is redundant).
 */
const OVERLAY_SECTIONS: readonly { key: keyof ReturnType<typeof groupTodos>; label: string; withCount: boolean }[] = [
  { key: 'in_progress', label: 'In progress', withCount: false },
  { key: 'review', label: 'Review', withCount: false },
  { key: 'pending', label: 'Pending', withCount: false },
  { key: 'blocked', label: 'Blocked', withCount: false },
  { key: 'cancelled', label: 'Cancelled', withCount: true },
  { key: 'completed', label: 'Completed', withCount: true },
];

/** Post-action status for the `<from> → <to>` triplet rendered in
 * `renderCall`. Pairs with `transitionGlyphs` from the reducer; that
 * helper supplies the `from` glyph, this one supplies the `to`. */
function actionToStatus(action: string): Todo['status'] {
  switch (action) {
    case 'start':
      return 'in_progress';
    case 'review':
      return 'review';
    case 'complete':
      return 'completed';
    case 'block':
      return 'blocked';
    case 'cancel':
      return 'cancelled';
    case 'reopen':
      return 'pending';
    default:
      return 'pending';
  }
}

function lastUserMessageHasMarker(ctx: ExtensionContext, marker: string, customType?: string): boolean {
  const branch = ctx.sessionManager.getBranch() as unknown as readonly VerifyBranchEntry[];
  return branchLastUserMessageHasMarker(branch, marker, customType);
}

// ──────────────────────────────────────────────────────────────────────
// /todos overlay
// ──────────────────────────────────────────────────────────────────────

export class TodoOverlay {
  private readonly state: TodoState;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly onClose: () => void;
  /** Viewport scroll offset (first visible body line); key-driven, no selection. */
  private scrollTop = 0;
  private maxScrollTop = 0;
  /** Visible body rows from the last render (a page for PageUp/PageDown). */
  private contentRows = 1;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(state: TodoState, theme: Theme, tui: TUI, onClose: () => void) {
    this.state = state;
    this.theme = theme;
    this.tui = tui;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, 'ctrl+p') || data === 'k') this.scrollTo(this.scrollTop - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, 'ctrl+n') || data === 'j')
      this.scrollTo(this.scrollTop + 1);
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, 'ctrl+b'))
      this.scrollTo(this.scrollTop - this.contentRows);
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, 'ctrl+f'))
      this.scrollTo(this.scrollTop + this.contentRows);
    else if (matchesKey(data, Key.home) || data === 'g') this.scrollTo(0);
    else if (matchesKey(data, Key.end) || data === 'G') this.scrollTo(this.maxScrollTop);
  }

  private scrollTo(target: number): void {
    const next = Math.max(0, Math.min(this.maxScrollTop, target));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    const th = this.theme;

    const total = this.state.todos.length;
    const completed = this.state.todos.filter((t) => t.status === 'completed').length;
    const chip = total > 0 ? `${completed}/${total}` : undefined;
    // Pinned frame: title above, help below; the grouped list scrolls between.
    const header = ['', truncateToWidth(formatHeaderRule('Todos', chip, width, th), width), ''];
    const footer = ['', truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width), ''];

    const body: string[] = [];
    if (total === 0) {
      body.push(truncateToWidth(`  ${th.fg('dim', 'No todos yet. Ask the agent to plan a multi-step task.')}`, width));
    } else {
      // Progress bar adapts to terminal width: 8 cells at 80 cols,
      // wider when there's room (capped at 20 so it never dominates).
      const barWidth = Math.max(4, Math.min(20, Math.floor(width / 10)));
      const progress = formatTodoProgress(this.state, { width: barWidth });
      const pctText = `${progress.pct}%`;
      const progressLine = `  ${th.fg('success', progress.bar)}  ${th.fg('muted', pctText)}${progress.summary ? `   ${th.fg('muted', progress.summary)}` : ''}`;
      body.push(truncateToWidth(progressLine, width));
      body.push('');

      const groups = groupTodos(this.state);
      const idPad = Math.max(...this.state.todos.map((t) => String(t.id).length)) + 1; // include '#'
      let firstSection = true;
      for (const section of OVERLAY_SECTIONS) {
        const items = groups[section.key];
        if (items.length === 0) continue;
        if (!firstSection) body.push('');
        firstSection = false;
        const headerLabel = section.withCount ? `${section.label} (${items.length})` : section.label;
        body.push(truncateToWidth(`  ${th.fg('muted', headerLabel)}`, width));
        for (const t of items) {
          for (const row of renderOverlayTodoLines(t, th, idPad)) {
            body.push(truncateToWidth(row, width));
          }
        }
      }
    }

    const win = assembleWindowedBody({
      header,
      body,
      footer,
      width,
      viewportRows: overlayViewportRows(rows),
      scrollTop: this.scrollTop,
      theme: th,
    });
    this.scrollTop = win.scrollTop;
    this.maxScrollTop = win.maxScrollTop;
    this.contentRows = win.contentRows;

    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = win.lines;
    return win.lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function todoExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_TODO_DISABLED)) return;

  const autoInjectEnabled = process.env.PI_TODO_DISABLE_AUTOINJECT !== '1';
  const guardrailEnabled = process.env.PI_TODO_DISABLE_GUARDRAIL !== '1';
  const maxInjected = parsePositiveInt(process.env.PI_TODO_MAX_INJECTED, MAX_INJECTED_DEFAULT);

  // In-memory mirror of the current branch's state. Reconstructed from the
  // session on session_start / session_tree and updated in place on each
  // successful tool call.
  let state: TodoState = emptyState();

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    state = reduceBranch(branch);
  };

  pi.on('session_start', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  // ── Active-plan auto-injection into every turn (via the `context` hook) ──
  // Splice a lean snapshot of the active plan as an ephemeral
  // <system-reminder> into the last user/toolResult turn. Pi's `context`
  // output is used only to build the outgoing payload and is never persisted,
  // so the SYSTEM PROMPT stays byte-stable (the provider's prompt-prefix cache
  // survives plan mutations) and nothing accumulates across turns. See
  // lib/node/pi/context-reminder.ts.
  if (autoInjectEnabled) {
    pi.on('context', (event) => {
      // Lean tail: active buckets only, no how-to footer and no cancelled
      // bucket. The tail is billed at full rate every turn (never cached),
      // so it carries only volatile state; the static how-to guidance lives
      // in the tool's `promptGuidelines` (a cached prompt location).
      const block = formatActivePlan(state, { maxItems: maxInjected, includeCancelled: false, footer: 'none' });
      // Nothing active (empty, or only completed/cancelled items) -> leave
      // the messages untouched so no reminder block rides the tail.
      if (!block) return undefined;
      const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
        id: 'todo-plan',
        body: block,
      });
      return { messages: messages as unknown as typeof event.messages };
    });
  }

  // ── Completion-claim guardrail ──────────────────────────────────────
  if (guardrailEnabled) {
    pi.on('agent_end', (event, ctx) => {
      const hasOpen = state.todos.some(
        (t) => t.status === 'in_progress' || t.status === 'review' || t.status === 'pending',
      );
      if (!hasOpen) return;

      const assistantText = extractLastAssistantText((event as { messages?: readonly unknown[] }).messages);
      if (!looksLikeCompletionClaim(assistantText)) return;

      // Loop guard: if the last user-equivalent boundary on the
      // branch is our own custom-nudge entry, we've already steered
      // this turn - don't fire again.
      if (lastUserMessageHasMarker(ctx, GUARDRAIL_MARKER, GUARDRAIL_CUSTOM_TYPE)) return;

      const inprog = state.todos.find((t) => t.status === 'in_progress');
      const inReview = state.todos.find((t) => t.status === 'review');
      const pending = state.todos.filter((t) => t.status === 'pending');
      const parts: string[] = [GUARDRAIL_MARKER];
      if (inprog) parts.push(`#${inprog.id} is still in_progress ("${inprog.text}").`);
      if (inReview) parts.push(`#${inReview.id} is in review awaiting verification ("${inReview.text}").`);
      if (pending.length > 0) parts.push(`${pending.length} pending item(s) remain.`);
      parts.push(
        'Either finish the work and call `todo` with action `complete` / `block` / `cancel`, or explain to the user why the plan is abandoned.',
      );

      // Delivery uses a `custom` message type so the nudge does NOT
      // pollute the editor's up-arrow history. Pi's convertToLlm
      // serializes `custom` -> a synthetic `user` turn whose content
      // still carries `GUARDRAIL_MARKER`.
      pi.sendMessage(
        { customType: GUARDRAIL_CUSTOM_TYPE, content: parts.join(' '), display: true },
        { deliverAs: 'followUp' },
      );
    });
  }

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'todo',
    label: 'Todo',
    description:
      'Plan and track multi-step work. Actions: list, add (text or items[]), start (id), review (id [, note]), complete (id [, note]), block (id, note), cancel (id, note), reopen (id), clear. One todo may be in_progress at a time, and one in review. Move in_progress → review when work is done but needs verification, then → complete once verified.',
    promptSnippet: 'Plan multi-step work up front and track progress across turns - use for any task with >1-2 steps',
    promptGuidelines: [
      'Call `todo` with action "add" and an `items` array BEFORE starting work on multi-step tasks, so the plan survives compaction and is visible every turn.',
      'Keep exactly one `todo` in_progress at a time via action "start". When the work is done but not yet verified, move it to review (action "review") before starting anything else.',
      'Complete items only after verification. If going straight from in_progress, include a `note` describing what verified the outcome (tests passed, file written, etc.). If going through review, completion can be plain - the review step was the verification parking.',
      'Use action "block" with a `note` when work is still needed but parked on an external dependency. Use action "cancel" with a `note` when an item is no longer in scope (superseded, duplicate, pivoted). Never silently abandon items.',
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let result: ActionResult;
      switch (params.action) {
        case 'list':
          result = actList(state);
          break;
        case 'add':
          result = actAdd(state, params.text, params.items);
          break;
        case 'start':
          result = actStart(state, params.id);
          break;
        case 'review':
          result = actReview(state, params.id, params.note);
          break;
        case 'complete':
          result = actComplete(state, params.id, params.note);
          break;
        case 'block':
          result = actBlock(state, params.id, params.note);
          break;
        case 'cancel':
          result = actCancel(state, params.id, params.note);
          break;
        case 'reopen':
          result = actReopen(state, params.id);
          break;
        case 'clear':
          result = actClear(state);
          break;
      }

      if (result.ok) {
        state = result.state;
        // Mirror to a custom session entry. Compaction can summarize
        // away old tool-result messages; the custom entry travels with
        // the branch and keeps the plan reconstructable.
        try {
          pi.appendEntry(TODO_CUSTOM_TYPE, cloneState(state));
        } catch {
          // Never let bookkeeping break the tool call.
        }
        const details: TodoDetails = { ...cloneState(state), action: params.action };
        const contentText = params.action === 'list' ? formatText(state) : `${result.summary}\n\n${formatText(state)}`;
        return { content: [{ type: 'text', text: contentText }], details };
      }

      const details: TodoDetails = { ...cloneState(state), action: params.action, error: result.error };
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        details,
        isError: true,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('todo ')) + theme.fg('muted', args.action);
      if (args.id !== undefined) text += ` ${theme.fg('accent', `#${args.id}`)}`;
      const triplet = transitionGlyphs(args.action);
      if (triplet) {
        text += `  ${theme.fg('dim', triplet.from)} ${theme.fg('dim', '→')} ${renderStatusGlyph(actionToStatus(args.action), theme)}`;
      }
      if (args.text) text += ` ${theme.fg('dim', `"${truncate(args.text, 60)}"`)}`;
      if (Array.isArray(args.items)) text += ` ${theme.fg('dim', `[${args.items.length} items]`)}`;
      if (args.note) text += `  ${theme.fg('dim', `(${truncate(args.note, 60)})`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<TodoDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      }
      const todos = details.todos ?? [];
      if (todos.length === 0) {
        return new Text(theme.fg('dim', 'No todos'), 0, 0);
      }
      const totals = { todos, nextId: 0 } satisfies TodoState;
      const progress = formatTodoProgress(totals, { width: 8 });
      const groups = groupTodos(totals);
      const idPad = Math.max(...todos.map((t) => String(t.id).length)) + 1;

      const parts: string[] = [];
      const headerSummary = progress.summary ? ` · ${progress.summary}` : '';
      parts.push(
        theme.fg('muted', `${groups.completed.length}/${todos.length} done  `) +
          progress.bar +
          theme.fg('muted', headerSummary),
      );

      const renderSection = (label: string, items: Todo[], withCount: boolean): void => {
        if (items.length === 0) return;
        parts.push('');
        parts.push(theme.fg('muted', withCount ? `${label} (${items.length})` : label));
        for (const t of items) parts.push(renderInlineTodo(t, theme, idPad));
      };

      renderSection('In progress', groups.in_progress, false);
      renderSection('Review', groups.review, false);
      renderSection('Pending', groups.pending, false);
      renderSection('Blocked', groups.blocked, false);
      // Cancelled is uncapped: the note carries the why-it-closed reason
      // and that signal is worth seeing in collapsed view.
      renderSection('Cancelled', groups.cancelled, true);

      if (expanded || groups.completed.length === 0) {
        renderSection('Completed', groups.completed, true);
      } else {
        parts.push('');
        parts.push(theme.fg('dim', `  … ${groups.completed.length} completed (Ctrl+O to expand)`));
      }

      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /todos command ──────────────────────────────────────────────────
  pi.registerCommand('todos', {
    description: 'Show the current todo list for this branch',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(TODOS_USAGE, 'info');
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(formatText(state), 'info');
        return;
      }
      await showModal<void>(ctx.ui, (tui, theme, _kb, done) => new TodoOverlay(state, theme, tui, () => done()));
    },
  });
}
