/**
 * Scratchpad extension for pi - unstructured working notes that survive
 * compaction and travel with the session branch.
 *
 * Companion to the `todo` extension. Where `todo` holds a typed plan
 * (pending / in_progress / review / completed / blocked), `scratchpad`
 * holds free-form notes the model benefits from carrying turn to turn:
 *
 *   - decisions made earlier in the session ("we chose approach B")
 *   - file paths it keeps rediscovering ("secrets live in config/env/*")
 *   - test / lint commands it keeps re-deriving ("./dev/test-docker.sh -q")
 *   - answers the user gave to clarifying questions
 *   - TODOs noticed in passing that don't belong in the structured plan
 *
 * Affordances mirror `todo.ts`:
 *
 *   1. Tool exposing CRUD actions over the note set (`append`, `update`,
 *      `remove`, `clear`, `list`).
 *
 *   2. System-prompt auto-injection (`before_agent_start`). The current
 *      notebook is rendered under a `## Working Notes` header with a soft
 *      character cap so long-running sessions don't eat the whole prompt.
 *      This is the biggest weak-model affordance after the `todo`
 *      guardrail: the model doesn't have to remember to call `list` every
 *      turn - the state is always in front of it.
 *
 *   3. Compaction resilience. Each successful tool call mirrors the
 *      post-action state to a `customType: 'scratchpad-state'` session
 *      entry in addition to `toolResult.details`. Pi's `/compact` can
 *      summarize tool-result messages away; the custom entry travels with
 *      the branch so the reducer can still reconstruct the notebook on
 *      `session_start` / `session_tree`.
 *
 *   4. Branch awareness. State is reconstructed from the branch by
 *      `reduceBranch` in `./lib/scratchpad-reducer.ts`, so `/fork`,
 *      `/tree`, and `/clone` automatically show the correct notes for
 *      that point in history. No external files, no cross-branch leakage.
 *
 * Pure logic (state transitions, prompt rendering) lives in
 * `./lib/scratchpad-reducer.ts` and `./lib/scratchpad-prompt.ts` so it
 * can be unit-tested under `vitest`. This file holds only
 * the pi-coupled glue.
 *
 * Environment:
 *   PI_SCRATCHPAD_DISABLED=1            skip the extension entirely
 *   PI_SCRATCHPAD_DISABLE_AUTOINJECT=1  tool still works but skip the
 *                                       before_agent_start block
 *   PI_SCRATCHPAD_MAX_INJECTED_CHARS=N  soft cap on the injected block
 *                                       (default 2000)
 */

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { formatWorkingNotes } from '../../../lib/node/pi/scratchpad-prompt.ts';
import {
  actAppend,
  actClear,
  actList,
  actRemove,
  actUpdate,
  type ActionResult,
  type BranchEntry,
  cloneState,
  emptyState,
  formatText,
  reduceBranch,
  SCRATCHPAD_CUSTOM_TYPE,
  type ScratchNote,
  type ScratchpadState,
} from '../../../lib/node/pi/scratchpad-reducer.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

const MAX_INJECTED_CHARS_DEFAULT = 2000;

const ScratchpadParams = Type.Object({
  action: StringEnum(['list', 'append', 'update', 'remove', 'clear'] as const),
  body: Type.Optional(
    Type.String({
      description:
        'Note body (for action "append"; optional for "update" - include to change the note text). Free-form markdown, one note per call.',
    }),
  ),
  heading: Type.Optional(
    Type.String({
      description:
        'Optional short heading grouping related notes in the injected block (e.g. "decisions", "test commands", "open questions"). Omit for ungrouped notes.',
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: 'Note ID (for actions "update" and "remove"). See the ids in the last `list` / injected block.',
    }),
  ),
});

interface ScratchpadDetails extends ScratchpadState {
  action: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function renderNoteLine(n: ScratchNote, theme: Theme): string {
  const id = theme.fg('accent', `#${n.id}`);
  const heading = n.heading ? theme.fg('muted', ` [${n.heading}]`) : '';
  const body = theme.fg('text', truncate(n.body, 160));
  return `  • ${id}${heading} ${body}`;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function scratchpadExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SCRATCHPAD_DISABLED === '1') return;

  const autoInjectEnabled = process.env.PI_SCRATCHPAD_DISABLE_AUTOINJECT !== '1';
  const maxInjectedChars = (() => {
    const raw = process.env.PI_SCRATCHPAD_MAX_INJECTED_CHARS;
    if (!raw) return MAX_INJECTED_CHARS_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 200 ? n : MAX_INJECTED_CHARS_DEFAULT;
  })();

  // In-memory mirror of the current branch's state. Reconstructed from
  // the session on session_start / session_tree and updated in place on
  // each successful tool call.
  let state: ScratchpadState = emptyState();

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
      const block = formatWorkingNotes(state, { maxChars: maxInjectedChars });
      if (!block) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  }

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'scratchpad',
    label: 'Scratchpad',
    description:
      'Persistent free-form notes that survive compaction and follow the session branch. Use for decisions, file paths, test commands, and any other carry-over state that is NOT a todo. Actions: list, append (body [, heading]), update (id [, body] [, heading]), remove (id), clear.',
    promptSnippet:
      'Carry decisions, paths, test commands, and other unstructured working state across turns so they survive compaction.',
    promptGuidelines: [
      'Use `scratchpad` (action `append`) to record any detail you want to remember next turn: chosen approach, flaky test names, environment paths, user answers. Prefer short, factual notes over long narrative.',
      'Call `scratchpad` action `update` or `remove` when a note becomes outdated - stale notes are worse than no notes.',
      'Do NOT duplicate the `todo` plan in the scratchpad. Use `todo` for action items that still need doing; use `scratchpad` for context and references.',
    ],
    parameters: ScratchpadParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let result: ActionResult;
      switch (params.action) {
        case 'list':
          result = actList(state);
          break;
        case 'append':
          result = actAppend(state, params.body, params.heading);
          break;
        case 'update':
          result = actUpdate(state, params.id, params.body, params.heading);
          break;
        case 'remove':
          result = actRemove(state, params.id);
          break;
        case 'clear':
          result = actClear(state);
          break;
      }

      if (result.ok) {
        state = result.state;
        // Mirror to a custom session entry. Compaction can summarize
        // away old tool-result messages; the custom entry travels with
        // the branch and keeps the notebook reconstructable.
        try {
          pi.appendEntry(SCRATCHPAD_CUSTOM_TYPE, cloneState(state));
        } catch {
          // Never let bookkeeping break the tool call.
        }
        const details: ScratchpadDetails = { ...cloneState(state), action: params.action };
        const contentText = params.action === 'list' ? formatText(state) : `${result.summary}\n\n${formatText(state)}`;
        return { content: [{ type: 'text', text: contentText }], details };
      }

      const details: ScratchpadDetails = { ...cloneState(state), action: params.action, error: result.error };
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        details,
        isError: true,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('scratchpad ')) + theme.fg('muted', args.action);
      if (args.id !== undefined) text += ` ${theme.fg('accent', `#${args.id}`)}`;
      if (args.heading) text += ` ${theme.fg('dim', `[${truncate(args.heading, 40)}]`)}`;
      if (args.body) text += ` ${theme.fg('dim', `"${truncate(args.body, 60)}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<ScratchpadDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      }
      const notes = details.notes ?? [];
      if (notes.length === 0) {
        return new Text(theme.fg('dim', '(scratchpad is empty)'), 0, 0);
      }
      const display = expanded ? notes : notes.slice(0, 6);
      const parts: string[] = [theme.fg('muted', `${notes.length} note(s)`)];
      for (const n of display) parts.push(renderNoteLine(n, theme));
      if (!expanded && notes.length > display.length) {
        parts.push(theme.fg('dim', `  … ${notes.length - display.length} more`));
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /scratchpad command ─────────────────────────────────────────────
  pi.registerCommand('scratchpad', {
    description: 'Show the scratchpad (no args or `list`) or `preview` the system-prompt injection',
    handler: async (args, ctx) => {
      const sub = (args ?? '').trim().toLowerCase();
      if (sub === '' || sub === 'list') {
        ctx.ui.notify(formatText(state), 'info');
        return;
      }
      if (sub === 'preview') {
        if (!autoInjectEnabled) {
          ctx.ui.notify(
            'Scratchpad auto-injection is disabled (PI_SCRATCHPAD_DISABLE_AUTOINJECT=1). ' +
              'Nothing would be added to the system prompt next turn.\n\n' +
              `Current notebook (${state.notes.length} note(s)):\n${formatText(state)}`,
            'info',
          );
          return;
        }
        const block = formatWorkingNotes(state, { maxChars: maxInjectedChars });
        if (!block) {
          ctx.ui.notify("(scratchpad is empty - nothing would be injected into the next turn's system prompt)", 'info');
          return;
        }
        ctx.ui.notify(
          `Injected into the next turn's system prompt (cap ${maxInjectedChars} chars, rendered ${block.length}):\n\n${block}`,
          'info',
        );
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /scratchpad [list|preview]`, 'warning');
    },
  });
}
