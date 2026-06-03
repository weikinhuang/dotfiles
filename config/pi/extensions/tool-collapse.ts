/**
 * Tool-collapse extension for pi - collapse a finished or fire-and-forget
 * tool call + its result down to a `[TOOL CALLED - reason]` marker to
 * reclaim context (e.g. a background comfyui job whose result the agent
 * never needed).
 *
 * One of three extensions on the shared context-edit core
 * (`lib/node/pi/context-edit/`); siblings are `context-trim` (remove
 * bulky content) and `message-edit` (edit a message in place). See
 * `context-trim.md` for the shared non-destructive overlay model: the
 * original call+result stay in the session `.jsonl`, the overlay is
 * reapplied each turn in the `context` hook and rebuilt from a persisted
 * `custom` entry on `session_start`, so manual collapses survive
 * `/reload` and exit -> resume. `restore` brings them back.
 *
 * Collapsing blanks the call's `arguments` AND replaces the paired tool
 * result with the marker, keeping the call/result pairing valid for the
 * provider.
 *
 * Affordances:
 *
 *   1. `/context-collapse` (no args) lists collapsible tool calls,
 *      heaviest first, with a background hint for fire-and-forget tools.
 *   2. `/context-collapse <handle> [reason]` collapses that call+result.
 *   3. `/context-collapse list` shows active collapses; `restore <#id>` /
 *      `clear` undo them.
 *
 * Optional auto-collapse (off by default): when
 * `PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS` (or the config file) is > 0, tool
 * results that are both that many assistant-turns old and over a size
 * threshold are collapsed TRANSIENTLY each turn. Auto-collapse is a
 * policy, not a user decision, so it is derived fresh each turn and never
 * persisted - there is nothing to undo; lower the knob to stop it.
 *
 * Pure logic lives under `lib/node/pi/context-edit/`. This file holds
 * only the pi-coupled glue.
 *
 * Environment:
 *   PI_TOOL_COLLAPSE_DISABLED=1            skip the extension entirely
 *   PI_TOOL_COLLAPSE_DISABLE_AUTO=1        keep manual collapse, disable auto
 *   PI_TOOL_COLLAPSE_MIN_BYTES=N           min result size to offer (default 2048)
 *   PI_TOOL_COLLAPSE_SNIPPET_CHARS=N       snippet width (default 80)
 *   PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS=N    auto-collapse results N turns old (0 = off)
 *   PI_TOOL_COLLAPSE_AUTO_MIN_BYTES=N      auto-collapse only results >= N bytes (default 4096)
 *   PI_TOOL_COLLAPSE_BACKGROUND_TOOLS=a,b  override the background-tool name list
 */

import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  DEFAULT_BACKGROUND_TOOLS,
  isBackgroundTool,
  selectAutoCollapse,
} from '../../../lib/node/pi/context-edit/auto-collapse.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import { loadToolCollapseConfig, type ToolCollapseConfig } from '../../../lib/node/pi/context-edit/config.ts';
import {
  addCollapse,
  clearDirectives,
  type CollapseDirective,
  type ContextEditState,
  cloneState,
  type Directive,
  emptyState,
  reduceBranch,
  removeDirective,
} from '../../../lib/node/pi/context-edit/directive.ts';
import { completeCandidatesOrVerbs, type CompletionCandidate } from '../../../lib/node/pi/context-edit/complete.ts';
import { type Candidate, candidateLabel, enumerate } from '../../../lib/node/pi/context-edit/enumerate.ts';
import type { LooseMessage } from '../../../lib/node/pi/context-edit/target.ts';
import { TOOL_COLLAPSE_USAGE } from '../../../lib/node/pi/context-edit/usage.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

const CUSTOM_TYPE = 'tool-collapse-state';

function parseBackgroundTools(raw: string | undefined): Set<string> {
  const names = raw?.trim()
    ? raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_BACKGROUND_TOOLS.map((s) => s.toLowerCase());
  return new Set(names);
}

export default function toolCollapseExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_TOOL_COLLAPSE_DISABLED)) return;

  const autoEnabled = !envTruthy(process.env.PI_TOOL_COLLAPSE_DISABLE_AUTO);
  const backgroundTools = parseBackgroundTools(process.env.PI_TOOL_COLLAPSE_BACKGROUND_TOOLS);

  let state: ContextEditState = emptyState();
  let lastContextMessages: LooseMessage[] | null = null;
  let config: ToolCollapseConfig = loadToolCollapseConfig(process.cwd());
  // Candidate handles for the Tab-completion menu (getArgumentCompletions
  // receives no ctx), refreshed from the context hook and after commands.
  let completionCandidates: CompletionCandidate[] = [];

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    state = reduceBranch(ctx.sessionManager.getBranch() as never, CUSTOM_TYPE);
    config = loadToolCollapseConfig(ctx.sessionManager.getCwd());
  };

  pi.on('session_start', (_event, ctx) => rebuildFromSession(ctx));
  pi.on('session_tree', (_event, ctx) => rebuildFromSession(ctx));

  const hint = (c: Candidate): string => (isBackgroundTool(c.toolName, backgroundTools) ? ' [background]' : '');

  // Collapsible candidates are tool calls (we list by call) and tool
  // results (size-gated). Merge them keyed by toolCallId so each call
  // shows once, preferring the heavier (result) representation.
  const candidatesFrom = (messages: readonly LooseMessage[]): Candidate[] => {
    const all = enumerate(messages, { minTextBytes: config.minTextBytes, snippetChars: config.snippetChars });
    const byId = new Map<string, Candidate>();
    for (const c of all) {
      if (c.kind !== 'tool-call' && c.kind !== 'tool-result') continue;
      if (!c.toolCallId) continue;
      const prev = byId.get(c.toolCallId);
      if (!prev || c.bytes > prev.bytes) byId.set(c.toolCallId, c);
    }
    return [...byId.values()].sort((a, b) => b.bytes - a.bytes);
  };

  const refreshCompletion = (cands: readonly Candidate[]): void => {
    completionCandidates = cands.map((c) => ({ id: c.id, description: `${candidateLabel(c)}${hint(c)}` }));
  };

  pi.on('context', (event) => {
    const messages = (event as unknown as { messages?: LooseMessage[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    lastContextMessages = messages;

    // Manual (persisted) collapses + transient auto-collapse selections.
    const directives: Directive[] = [...state.directives];
    if (autoEnabled && config.autoAfterTurns > 0) {
      const autoIds = selectAutoCollapse(messages, {
        afterTurns: config.autoAfterTurns,
        minBytes: config.autoMinBytes,
      });
      const already = new Set(
        directives.filter((d): d is CollapseDirective => d.kind === 'collapse').map((d) => d.toolCallId),
      );
      let autoId = -1;
      for (const toolCallId of autoIds) {
        if (already.has(toolCallId)) continue;
        directives.push({ kind: 'collapse', id: autoId--, toolCallId, reason: 'auto (aged out)', createdAt: 0 });
      }
    }

    let out = messages;
    let applied = 0;
    if (directives.length > 0) {
      const result = applyDirectives(messages, directives);
      lastContextMessages = result.messages;
      out = result.messages;
      applied = result.applied;
    }
    refreshCompletion(candidatesFrom(out));
    return applied > 0 ? { messages: out as never } : undefined;
  });

  const currentMessages = (ctx: ExtensionContext): LooseMessage[] => {
    if (lastContextMessages) return lastContextMessages;
    try {
      const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      return (built.messages as unknown as LooseMessage[]) ?? [];
    } catch {
      return [];
    }
  };

  const collapseCandidates = (ctx: ExtensionContext): Candidate[] => {
    const cands = candidatesFrom(currentMessages(ctx));
    refreshCompletion(cands);
    return cands;
  };

  const persist = (): void => {
    try {
      pi.appendEntry(CUSTOM_TYPE, cloneState(state));
    } catch {
      // Never let bookkeeping break the command.
    }
    lastContextMessages = null;
  };

  const listCandidates = (ctx: ExtensionContext): string => {
    const cands = collapseCandidates(ctx);
    if (cands.length === 0) return 'No collapsible tool calls in the current context.';
    const lines = cands.map((c) => `  ${c.id}  ${candidateLabel(c)}${hint(c)}`);
    return [
      'Collapsible tool calls (heaviest first):',
      ...lines,
      '',
      'Collapse with: /context-collapse <id> [reason]',
    ].join('\n');
  };

  const listActive = (): string => {
    const cols = state.directives.filter((d): d is CollapseDirective => d.kind === 'collapse');
    if (cols.length === 0) return 'No active manual collapses.';
    return ['Active collapses:', ...cols.map((d) => `  #${d.id}  ${d.toolCallId} ${d.reason ?? ''}`.trimEnd())].join(
      '\n',
    );
  };

  pi.registerCommand('context-collapse', {
    description: 'Collapse a tool call + result to a marker to reclaim context',
    getArgumentCompletions: (prefix) =>
      completeCandidatesOrVerbs(prefix, completionCandidates, {
        list: { description: 'Show active collapses' },
        restore: {
          description: 'Undo a collapse by #id',
          args: () => state.directives.filter((d) => d.kind === 'collapse').map((d) => ({ label: String(d.id) })),
        },
        clear: { description: 'Undo all manual collapses' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(TOOL_COLLAPSE_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      if (raw === '') {
        ctx.ui.notify(listCandidates(ctx), 'info');
        return;
      }

      const [verb, ...rest] = raw.split(/\s+/);
      const tail = rest.join(' ');

      if (verb === 'list') {
        ctx.ui.notify(listActive(), 'info');
        return;
      }
      if (verb === 'clear') {
        const r = clearDirectives(state, 'collapse');
        if (r.ok) {
          state = r.state;
          persist();
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }
      if (verb === 'restore') {
        const id = Number.parseInt(tail, 10);
        if (!Number.isFinite(id)) {
          ctx.ui.notify('restore needs a numeric #id (see /context-collapse list)', 'warning');
          return;
        }
        const r = removeDirective(state, id);
        if (r.ok) {
          state = r.state;
          persist();
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }

      const cand = collapseCandidates(ctx).find((c) => c.id === verb);
      if (!cand?.toolCallId) {
        ctx.ui.notify(`Unknown candidate "${verb}". Run /context-collapse to list handles.`, 'warning');
        return;
      }
      const r = addCollapse(state, cand.toolCallId, tail || undefined, Date.now());
      if (r.ok) {
        state = r.state;
        persist();
        ctx.ui.notify(`${r.summary}: ${candidateLabel(cand)}`, 'info');
      } else {
        ctx.ui.notify(r.error, 'warning');
      }
    },
  });
}
