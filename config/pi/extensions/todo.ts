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
 *   2. System-prompt auto-injection (`before_agent_start`). The current
 *      in_progress + pending + blocked list is appended to the system
 *      prompt every turn. This is the single most valuable affordance
 *      for weaker models: the plan stays visible across compactions and
 *      long contexts without the model having to remember to call
 *      `list` on its own.
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
 *   PI_TODO_DISABLE_AUTOINJECT=1  tool still works but skip the
 *                                 before_agent_start system-prompt block
 *   PI_TODO_DISABLE_GUARDRAIL=1   don't fire the agent_end "you claimed
 *                                 done but items are still open" steer
 *   PI_TODO_MAX_INJECTED=N        cap on pending items rendered in the
 *                                 injected block (default 10)
 */

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { truncate } from '../../../lib/node/pi/shared.ts';
import { formatActivePlan, looksLikeCompletionClaim } from '../../../lib/node/pi/todo-prompt.ts';
import {
  actAdd,
  actBlock,
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
  formatText,
  reduceBranch,
  TODO_CUSTOM_TYPE,
  type Todo,
  type TodoState,
} from '../../../lib/node/pi/todo-reducer.ts';

// Sentinel prepended to the guardrail steer. We detect it on the most
// recent user message to make the guardrail idempotent across re-fires
// within a single turn (model ignores the steer and claims done again).
const GUARDRAIL_MARKER = '⚠ [pi-todo-guardrail]';
const MAX_INJECTED_DEFAULT = 10;

const TodoParams = Type.Object({
  action: StringEnum(['list', 'add', 'start', 'review', 'complete', 'block', 'reopen', 'clear'] as const),
  text: Type.Optional(Type.String({ description: 'Todo text (for action "add")' })),
  items: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Multiple todo texts to add at once. Use this for the initial plan.',
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: 'Todo ID (for actions "start", "review", "complete", "block", "reopen")',
    }),
  ),
  note: Type.Optional(
    Type.String({
      description:
        'Free-form note. REQUIRED for "block" (reason the task is blocked) and for "complete" when coming directly from in_progress (what verified the outcome). Optional elsewhere.',
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

function renderTodoLine(t: Todo, theme: Theme): string {
  const marker =
    t.status === 'completed'
      ? theme.fg('success', '✓')
      : t.status === 'in_progress'
        ? theme.fg('accent', theme.bold('→'))
        : t.status === 'review'
          ? theme.fg('warning', '⋯')
          : t.status === 'blocked'
            ? theme.fg('error', '⛔')
            : theme.fg('dim', '○');
  const textStyled = t.status === 'completed' ? theme.fg('dim', t.text) : theme.fg('text', t.text);
  const note = t.note ? ` ${theme.fg('dim', `(${t.note})`)}` : '';
  return `  ${marker} ${theme.fg('accent', `#${t.id}`)} ${textStyled}${note}`;
}

/**
 * Pull the last assistant text from an `agent_end` event. The event's
 * message shape varies across providers (string content vs content-part
 * array), so we handle both defensively and fall back to empty string.
 */
function extractLastAssistantText(event: unknown): string {
  const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          const text = (c as { text?: string }).text;
          if (typeof text === 'string') parts.push(text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }
  return '';
}

/**
 * Check whether the most recent user message on the current branch
 * contains the guardrail marker. Used to prevent the guardrail from
 * re-firing on turns that already received a steer.
 */
function lastUserMessageHasMarker(ctx: ExtensionContext, marker: string): boolean {
  const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'message') continue;
    const msg = entry.message as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'user') continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          text += (c as { text?: string }).text ?? '';
        }
      }
    }
    return text.includes(marker);
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// /todos overlay
// ──────────────────────────────────────────────────────────────────────

class TodoOverlay {
  private readonly state: TodoState;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: TodoState, theme: Theme, onClose: () => void) {
    this.state = state;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [''];
    const title = th.fg('accent', ' Todos ');
    lines.push(
      truncateToWidth(
        th.fg('borderMuted', '─'.repeat(3)) + title + th.fg('borderMuted', '─'.repeat(Math.max(0, width - 10))),
        width,
      ),
    );
    lines.push('');

    if (this.state.todos.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg('dim', 'No todos yet. Ask the agent to plan a multi-step task.')}`, width));
    } else {
      const counts = { pending: 0, in_progress: 0, review: 0, completed: 0, blocked: 0 };
      for (const t of this.state.todos) counts[t.status]++;
      const summary =
        `${counts.completed}/${this.state.todos.length} done` +
        (counts.in_progress ? ` · ${counts.in_progress} active` : '') +
        (counts.review ? ` · ${counts.review} in review` : '') +
        (counts.pending ? ` · ${counts.pending} pending` : '') +
        (counts.blocked ? ` · ${counts.blocked} blocked` : '');
      lines.push(truncateToWidth(`  ${th.fg('muted', summary)}`, width));
      lines.push('');
      for (const t of this.state.todos) lines.push(truncateToWidth(renderTodoLine(t, th), width));
    }

    lines.push('');
    lines.push(truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width));
    lines.push('');

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function todoExtension(pi: ExtensionAPI): void {
  if (process.env.PI_TODO_DISABLED === '1') return;

  const autoInjectEnabled = process.env.PI_TODO_DISABLE_AUTOINJECT !== '1';
  const guardrailEnabled = process.env.PI_TODO_DISABLE_GUARDRAIL !== '1';
  const maxInjected = (() => {
    const raw = process.env.PI_TODO_MAX_INJECTED;
    if (!raw) return MAX_INJECTED_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : MAX_INJECTED_DEFAULT;
  })();

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

  // ── Auto-injection into every turn ──────────────────────────────────
  if (autoInjectEnabled) {
    pi.on('before_agent_start', (event) => {
      const block = formatActivePlan(state, { maxItems: maxInjected });
      if (!block) return undefined;
      // Chain onto whatever earlier handlers (or pi's default) set up.
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  }

  // ── Completion-claim guardrail ──────────────────────────────────────
  if (guardrailEnabled) {
    pi.on('agent_end', (event, ctx) => {
      const hasOpen = state.todos.some(
        (t) => t.status === 'in_progress' || t.status === 'review' || t.status === 'pending',
      );
      if (!hasOpen) return;

      const assistantText = extractLastAssistantText(event);
      if (!looksLikeCompletionClaim(assistantText)) return;

      // Loop guard: if the last user message on the branch already carries
      // our marker, we've already steered this turn - don't fire again.
      if (lastUserMessageHasMarker(ctx, GUARDRAIL_MARKER)) return;

      const inprog = state.todos.find((t) => t.status === 'in_progress');
      const inReview = state.todos.find((t) => t.status === 'review');
      const pending = state.todos.filter((t) => t.status === 'pending');
      const parts: string[] = [GUARDRAIL_MARKER];
      if (inprog) parts.push(`#${inprog.id} is still in_progress ("${inprog.text}").`);
      if (inReview) parts.push(`#${inReview.id} is in review awaiting verification ("${inReview.text}").`);
      if (pending.length > 0) parts.push(`${pending.length} pending item(s) remain.`);
      parts.push(
        'Either finish the work and call `todo` with action `complete` / `block`, or explain to the user why the plan is abandoned.',
      );

      pi.sendUserMessage(parts.join(' '), { deliverAs: 'followUp' });
    });
  }

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'todo',
    label: 'Todo',
    description:
      'Plan and track multi-step work. Actions: list, add (text or items[]), start (id), review (id [, note]), complete (id [, note]), block (id, note), reopen (id), clear. One todo may be in_progress at a time, and one in review. Move in_progress → review when work is done but needs verification, then → complete once verified.',
    promptSnippet: 'Plan multi-step work up front and track progress across turns - use for any task with >1-2 steps',
    promptGuidelines: [
      'Call `todo` with action "add" and an `items` array BEFORE starting work on multi-step tasks, so the plan survives compaction and is visible every turn.',
      'Keep exactly one `todo` in_progress at a time via action "start". When the work is done but not yet verified, move it to review (action "review") before starting anything else.',
      'Complete items only after verification. If going straight from in_progress, include a `note` describing what verified the outcome (tests passed, file written, etc.). If going through review, completion can be plain - the review step was the verification parking.',
      'If you hit an obstacle, use action "block" with a `note` explaining why - do not silently abandon items.',
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
      if (args.text) text += ` ${theme.fg('dim', `"${truncate(args.text, 60)}"`)}`;
      if (Array.isArray(args.items)) text += ` ${theme.fg('dim', `[${args.items.length} items]`)}`;
      if (args.note) text += ` ${theme.fg('dim', `(${truncate(args.note, 40)})`)}`;
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
      const counts = { pending: 0, in_progress: 0, review: 0, completed: 0, blocked: 0 };
      for (const t of todos) counts[t.status]++;
      const display = expanded ? todos : todos.slice(0, 8);
      const parts: string[] = [
        theme.fg(
          'muted',
          `${counts.completed}/${todos.length} done` +
            (counts.in_progress ? ` · ${counts.in_progress} active` : '') +
            (counts.review ? ` · ${counts.review} in review` : '') +
            (counts.blocked ? ` · ${counts.blocked} blocked` : ''),
        ),
      ];
      for (const t of display) parts.push(renderTodoLine(t, theme));
      if (!expanded && todos.length > display.length) {
        parts.push(theme.fg('dim', `  … ${todos.length - display.length} more`));
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /todos command ──────────────────────────────────────────────────
  pi.registerCommand('todos', {
    description: 'Show the current todo list for this branch',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(formatText(state), 'info');
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoOverlay(state, theme, () => done()));
    },
  });
}
