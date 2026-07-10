/**
 * `/context` - interactive, drill-down context-usage breakdown.
 *
 * A Claude-Code-`/context`-style visual map of everything occupying the
 * model's context window: the system prompt (decomposed into core
 * instructions, guidelines, tool snippets, each context file, skills,
 * injected per-turn addenda), the serialized tool schemas, and the whole
 * conversation (bucketed by role and by tool), plus free space.
 *
 * The view is a treemap: the 10×10 grid always represents the CURRENT node
 * as 100%, colored by that node's children. Drilling re-scopes the grid; a
 * breadcrumb shows the node's absolute window share. Numbers are chars/4
 * estimates (matching pi's own `estimateTokens`); the provider's real total
 * is shown in the header / reconciliation panel as authoritative.
 *
 * Pure logic (tree build, grid math, navigation, formatting, export) lives
 * under `lib/node/pi/context-usage/` and is vitest-covered; the pi-tui
 * overlay component lives in `lib/node/pi/ext/context-usage-overlay.ts`. This
 * shell only adapts pi APIs and mounts the overlay.
 *
 * Environment:
 *   PI_CONTEXT_USAGE_DISABLED=1   skip the extension entirely
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildSessionContext, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import { ContextOverlay } from '../../../lib/node/pi/ext/context-usage-overlay.ts';
import { CONTEXT_USAGE_USAGE } from '../../../lib/node/pi/context-usage/usage.ts';
import { buildBreakdown } from '../../../lib/node/pi/context-usage/estimate.ts';
import { exportFilename, renderMarkdown } from '../../../lib/node/pi/context-usage/export.ts';
import type { Breakdown, BreakdownInput } from '../../../lib/node/pi/context-usage/types.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

/**
 * Gather all inputs from the command context and build the breakdown.
 *
 * `baseSystemPrompt` is the prompt captured at `before_agent_start` (the base
 * plus injections from extensions loaded before this one). The installed pi
 * doesn't export `buildSystemPrompt`, so this capture is how we recover a base
 * to diff the injected per-turn addenda against. When no turn has run yet it
 * falls back to the effective prompt (→ no injected bucket).
 */
function gatherBreakdown(pi: ExtensionAPI, ctx: ExtensionCommandContext, capturedBase: string | undefined): Breakdown {
  const options = ctx.getSystemPromptOptions();
  const effectiveSystemPrompt = ctx.getSystemPrompt();
  const baseSystemPrompt = capturedBase ?? effectiveSystemPrompt;
  const entries = ctx.sessionManager.getBranch();
  const { messages } = buildSessionContext(entries);
  const usage = ctx.getContextUsage();

  const input: BreakdownInput = {
    effectiveSystemPrompt,
    baseSystemPrompt,
    systemPromptOptions: options,
    allTools: pi.getAllTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    activeToolNames: pi.getActiveTools(),
    messages,
    contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    realTokens: usage?.tokens ?? null,
    modelId: ctx.model?.id,
    provider: ctx.model?.provider,
  };
  return buildBreakdown(input);
}

// ──────────────────────────────────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────────────────────────────────

export default function contextUsage(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CONTEXT_USAGE_DISABLED)) return;

  let activeDone: (() => void) | undefined;
  // Base system prompt captured each turn (base + injections from extensions
  // loaded before this one). Used to diff out per-turn injected addenda, since
  // the installed pi doesn't export `buildSystemPrompt`.
  let capturedBase: string | undefined;

  pi.on('before_agent_start', (event) => {
    capturedBase = event.systemPrompt;
    return undefined;
  });

  pi.registerCommand('context', {
    description: 'Interactive drill-down breakdown of context-window usage',
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_USAGE_USAGE, 'info');
        return;
      }

      const rebuild = (): Breakdown => gatherBreakdown(pi, ctx, capturedBase);

      // Non-TUI: flat markdown report via notify.
      if (!ctx.hasUI) {
        ctx.ui.notify(renderMarkdown(rebuild()), 'info');
        return;
      }

      const exportReport = (breakdown: Breakdown): string => {
        const path = resolve(ctx.cwd, exportFilename());
        writeFileSync(path, renderMarkdown(breakdown), 'utf8');
        return path;
      };

      await showModal<void>(ctx.ui, (tui, theme, _kb, done) => {
        const overlay = new ContextOverlay({
          theme,
          tui,
          rebuild,
          compact: () => ctx.compact(),
          exportReport,
          done,
        });
        activeDone = done;
        return overlay;
      });
      activeDone = undefined;
    },
  });

  pi.on('session_shutdown', () => {
    // Close any open overlay so /reload doesn't leak a focused component.
    try {
      activeDone?.();
    } catch {
      // ignore
    }
    activeDone = undefined;
  });
}
