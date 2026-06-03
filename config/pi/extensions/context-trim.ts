/**
 * Context-trim extension for pi - remove large/bulky content (images,
 * oversized tool results, long messages) from the model's context,
 * replaced by a short placeholder, to reclaim context window.
 *
 * This is one of three extensions built on the shared context-edit core
 * (`lib/node/pi/context-edit/`); the others are `message-edit` (edit a
 * message in place) and `tool-collapse` (collapse a tool call+result).
 * All three apply a NON-DESTRUCTIVE overlay in the `context` hook: the
 * original content stays recorded in the session `.jsonl`, the overlay is
 * reapplied every turn, and it is reconstructed from a persisted `custom`
 * session entry on `session_start` - so trims survive `/reload` AND exit
 * -> resume. Nothing is ever actually deleted; `restore` brings it back.
 *
 * Why not pi's append-only branching? Branching from an earlier entry
 * deletes every downstream turn. Trimming one image in the middle of a
 * long session must keep all later turns intact, so we overlay instead.
 *
 * Affordances:
 *
 *   1. `/context-trim` (no args) lists trimmable candidates, heaviest
 *      first: images, tool results over a size threshold, and long
 *      user/assistant messages. Each gets a short handle (img1, tool3,
 *      msg2) you pass to trim it.
 *
 *   2. `/context-trim <handle> [reason]` adds a trim directive. From the
 *      next turn the targeted content shows as `[IMAGE REMOVED]` /
 *      `[CONTENT TRIMMED - N lines, X KB]`.
 *
 *   3. `/context-trim list` shows active trims; `restore <#id>` / `clear`
 *      undo them.
 *
 * Pure logic (directive set, target resolution, the overlay pass,
 * candidate enumeration, config) lives under
 * `lib/node/pi/context-edit/` so it is unit-tested under vitest. This
 * file holds only the pi-coupled glue.
 *
 * Environment:
 *   PI_CONTEXT_TRIM_DISABLED=1        skip the extension entirely
 *   PI_CONTEXT_TRIM_MIN_BYTES=N       min text-part size to offer (default 2048)
 *   PI_CONTEXT_TRIM_SNIPPET_CHARS=N   snippet width in listings (default 80)
 */

import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import { loadTrimConfig, type TrimConfig } from '../../../lib/node/pi/context-edit/config.ts';
import {
  addTrim,
  clearDirectives,
  type ContextEditState,
  cloneState,
  emptyState,
  reduceBranch,
  removeDirective,
} from '../../../lib/node/pi/context-edit/directive.ts';
import { completeCandidatesOrVerbs, type CompletionCandidate } from '../../../lib/node/pi/context-edit/complete.ts';
import { type Candidate, candidateLabel, enumerate } from '../../../lib/node/pi/context-edit/enumerate.ts';
import type { LooseMessage } from '../../../lib/node/pi/context-edit/target.ts';
import { CONTEXT_TRIM_USAGE } from '../../../lib/node/pi/context-edit/usage.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

const CUSTOM_TYPE = 'context-trim-state';

export default function contextTrimExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CONTEXT_TRIM_DISABLED)) return;

  // Per-session directive set, rebuilt from the branch on load.
  let state: ContextEditState = emptyState();
  // Snapshot of the resolved messages from the most recent `context`
  // hook - the exact list the model saw - so `/context-trim` enumerates
  // candidates that resolve back cleanly. Before the first LLM call we
  // fall back to building the context from session entries on demand.
  let lastContextMessages: LooseMessage[] | null = null;
  let config: TrimConfig = loadTrimConfig(process.cwd());
  // Candidate handles for the Tab-completion menu. `getArgumentCompletions`
  // receives no ctx, so we keep this snapshot fresh from the context hook
  // (and after each command) and let completion read it.
  let completionCandidates: CompletionCandidate[] = [];

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    state = reduceBranch(ctx.sessionManager.getBranch() as never, CUSTOM_TYPE);
    config = loadTrimConfig(ctx.sessionManager.getCwd());
  };

  pi.on('session_start', (_event, ctx) => rebuildFromSession(ctx));
  pi.on('session_tree', (_event, ctx) => rebuildFromSession(ctx));

  // Only candidates worth trimming: images, large tool results, and long
  // messages (drop the tool-call kind - that's tool-collapse's job).
  const candidatesFrom = (messages: readonly LooseMessage[]): Candidate[] =>
    enumerate(messages, { minTextBytes: config.minTextBytes, snippetChars: config.snippetChars }).filter(
      (c) => c.kind !== 'tool-call',
    );

  // Keep the Tab-completion snapshot in sync with the latest candidates.
  const refreshCompletion = (cands: readonly Candidate[]): void => {
    completionCandidates = cands.map((c) => ({ id: c.id, description: candidateLabel(c) }));
  };

  // Apply the overlay every turn, snapshot what the model sees, and refresh
  // the completion candidates so the menu reflects the live context.
  pi.on('context', (event) => {
    const messages = (event as unknown as { messages?: LooseMessage[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    lastContextMessages = messages;
    let out = messages;
    let applied = 0;
    if (state.directives.length > 0) {
      const result = applyDirectives(messages, state.directives);
      lastContextMessages = result.messages;
      out = result.messages;
      applied = result.applied;
    }
    refreshCompletion(candidatesFrom(out));
    return applied > 0 ? { messages: out as never } : undefined;
  });

  // Resolve the message list to enumerate against: prefer the live
  // snapshot, else build it from the current branch.
  const currentMessages = (ctx: ExtensionContext): LooseMessage[] => {
    if (lastContextMessages) return lastContextMessages;
    try {
      const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      return (built.messages as unknown as LooseMessage[]) ?? [];
    } catch {
      return [];
    }
  };

  const trimCandidates = (ctx: ExtensionContext): Candidate[] => {
    const cands = candidatesFrom(currentMessages(ctx));
    refreshCompletion(cands);
    return cands;
  };

  const persist = (ctx: ExtensionContext): void => {
    try {
      pi.appendEntry(CUSTOM_TYPE, cloneState(state));
    } catch {
      // Never let bookkeeping break the command.
    }
    // Re-snapshot so a follow-up listing reflects the new overlay.
    lastContextMessages = null;
    void ctx;
  };

  const listCandidates = (ctx: ExtensionContext): string => {
    const cands = trimCandidates(ctx);
    if (cands.length === 0) return 'Nothing large enough to trim in the current context.';
    const lines = cands.map((c) => `  ${c.id}  ${candidateLabel(c)}`);
    return ['Trimmable content (heaviest first):', ...lines, '', 'Trim with: /context-trim <id> [reason]'].join('\n');
  };

  const listActive = (): string => {
    const trims = state.directives.filter((d) => d.kind === 'trim');
    if (trims.length === 0) return 'No active trims.';
    return ['Active trims:', ...trims.map((d) => `  #${d.id}  ${d.reason ?? '(no reason)'}`)].join('\n');
  };

  pi.registerCommand('context-trim', {
    description: 'Trim large content (images, big tool results, long messages) out of the context',
    getArgumentCompletions: (prefix) =>
      completeCandidatesOrVerbs(prefix, completionCandidates, {
        list: { description: 'Show active trims' },
        restore: {
          description: 'Undo a trim by #id',
          args: () => state.directives.filter((d) => d.kind === 'trim').map((d) => ({ label: String(d.id) })),
        },
        clear: { description: 'Undo all trims' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_TRIM_USAGE, 'info');
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
        const r = clearDirectives(state, 'trim');
        if (r.ok) {
          state = r.state;
          persist(ctx);
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }
      if (verb === 'restore') {
        const id = Number.parseInt(tail, 10);
        if (!Number.isFinite(id)) {
          ctx.ui.notify('restore needs a numeric #id (see /context-trim list)', 'warning');
          return;
        }
        const r = removeDirective(state, id);
        if (r.ok) {
          state = r.state;
          persist(ctx);
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }

      // Otherwise treat the first token as a candidate handle.
      const cand = trimCandidates(ctx).find((c) => c.id === verb);
      if (!cand?.target) {
        ctx.ui.notify(`Unknown candidate "${verb}". Run /context-trim to list handles.`, 'warning');
        return;
      }
      const reason = tail || undefined;
      const r = addTrim(state, cand.target, reason, Date.now());
      if (r.ok) {
        state = r.state;
        persist(ctx);
        ctx.ui.notify(`${r.summary}: ${candidateLabel(cand)}`, 'info');
      } else {
        ctx.ui.notify(r.error, 'warning');
      }
    },
  });
}
