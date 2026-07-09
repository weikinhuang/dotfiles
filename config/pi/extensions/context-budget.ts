/**
 * Context-budget extension for pi - surfaces the model's own context-window
 * usage to the model each turn and optionally triggers auto-compaction.
 *
 * Pi's footer already shows `N% left` to the user via `ctx.getContextUsage()`,
 * but the model doesn't see the footer. Weaker models (and some confident
 * larger ones) will happily run a dozen 10KB `read`s back to back without
 * noticing they've burned through the window. This extension closes the
 * loop: each turn a one-line advisory - "Context: 72% used (13k tokens left
 * of 200k). Prefer targeted `rg` / `read --offset / --limit` …" - is
 * surfaced to the model so it sees the number AND the remediation together.
 *
 * The tone escalates with usage. See `formatBudgetLine` in
 * `./lib/context-budget.ts`:
 *
 *   - Under the min percent (default 50): no line. Casual single-turn
 *     chats and early-session work don't need the nag.
 *   - Between min and warn (default 50–80%): neutral advisory.
 *   - Between warn and critical (default 80–90%): "be efficient" tone.
 *   - At or above critical (default 90%): "you are running out" tone,
 *     with an explicit pointer at `/compact`.
 *
 * Optional auto-compaction: when `PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT`
 * is set to a percent in (0, 100), the extension will call `ctx.compact()`
 * once when usage EDGE-TRIGGERS across that threshold (i.e. was below on
 * the previous turn and is above now). The edge-trigger means we don't
 * re-compact every turn while sitting above the line. Off by default -
 * auto-compaction is a big hammer.
 *
 * Delivery: the advisory rides the `context` hook as an ephemeral
 * `<system-reminder id="context-budget">` spliced into the last
 * user/toolResult turn, NOT the system prompt. The budget line changes
 * almost every turn once usage passes the min percent (the exact token
 * count moves), so appending it to the system prompt would bust the
 * provider's prompt-prefix cache on every turn through the whole back half
 * of a long session - precisely when caching matters most. Riding the
 * (already-uncached) tail keeps the system prompt byte-stable. Pi's
 * `context` output is never persisted, so nothing accumulates and no line
 * is injected below the min percent. See lib/node/pi/context-reminder.ts.
 *
 * Pure helpers (`formatBudgetLine`, `shouldAutoCompact`, `formatTokens`)
 * live in `./lib/context-budget.ts` so the thresholds and wording can
 * be unit-tested under `vitest`.
 *
 * Environment:
 *   PI_CONTEXT_BUDGET_DISABLED=1                  skip the extension
 *   PI_CONTEXT_BUDGET_MIN_PERCENT=N               start injecting at N%
 *                                                 (default 50)
 *   PI_CONTEXT_BUDGET_WARN_PERCENT=N              shift tone at N%
 *                                                 (default 80)
 *   PI_CONTEXT_BUDGET_CRITICAL_PERCENT=N          critical tone at N%
 *                                                 (default 90)
 *   PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N      auto-compact when usage
 *                                                 edge-crosses N%
 *                                                 (unset = off)
 *   PI_CONTEXT_BUDGET_AUTO_COMPACT_INSTRUCTIONS=TEXT
 *                                                 extra instructions passed
 *                                                 to compact() when auto-
 *                                                 triggered
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { type BudgetOptions, formatBudgetLine, shouldAutoCompact } from '../../../lib/node/pi/context-budget.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { buildBudgetPreview } from '../../../lib/node/pi/context-budget/preview.ts';
import { CONTEXT_BUDGET_USAGE } from '../../../lib/node/pi/context-budget/usage.ts';
import { envTruthy, parsePercent } from '../../../lib/node/pi/parse-env.ts';

const DEFAULT_MIN = 50;
const DEFAULT_WARN = 80;
const DEFAULT_CRITICAL = 90;

function triggerCompaction(ctx: ExtensionContext, customInstructions: string | undefined): void {
  if (ctx.hasUI) ctx.ui.notify('context-budget: triggering auto-compaction', 'info');
  ctx.compact({
    customInstructions,
    onComplete: () => {
      if (ctx.hasUI) ctx.ui.notify('context-budget: compaction completed', 'info');
    },
    onError: (error) => {
      if (ctx.hasUI) ctx.ui.notify(`context-budget: compaction failed: ${error.message}`, 'error');
    },
  });
}

export default function contextBudget(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CONTEXT_BUDGET_DISABLED)) return;

  const options: BudgetOptions = {
    minPercent: parsePercent(process.env.PI_CONTEXT_BUDGET_MIN_PERCENT, DEFAULT_MIN),
    warnPercent: parsePercent(process.env.PI_CONTEXT_BUDGET_WARN_PERCENT, DEFAULT_WARN),
    criticalPercent: parsePercent(process.env.PI_CONTEXT_BUDGET_CRITICAL_PERCENT, DEFAULT_CRITICAL),
  };

  // `null` if unset → auto-compaction disabled.
  const autoCompactThreshold = parsePercent(process.env.PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT, null);
  const autoCompactRaw = process.env.PI_CONTEXT_BUDGET_AUTO_COMPACT_INSTRUCTIONS?.trim();
  const autoCompactInstructions = autoCompactRaw?.length ? autoCompactRaw : undefined;

  // Remember the prior turn's percent so we can edge-trigger compaction.
  // Reset on session_start so we don't carry stale state across sessions.
  let previousPercent: number | null = null;
  // Don't fire compaction more than once per session without us seeing
  // usage drop back below the threshold first. Belt-and-suspenders on
  // top of the edge trigger in shouldAutoCompact().
  let compactedThisSession = false;

  pi.on('session_start', () => {
    previousPercent = null;
    compactedThisSession = false;
  });

  pi.on('context', (event, ctx) => {
    const usage = ctx.getContextUsage();
    const line = formatBudgetLine(usage ?? null, options);
    if (!line) return undefined;
    const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
      id: 'context-budget',
      body: line,
    });
    return { messages: messages as unknown as typeof event.messages };
  });

  pi.on('turn_end', (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const current = usage?.percent ?? null;

    if (autoCompactThreshold !== null && !compactedThisSession) {
      if (shouldAutoCompact(current, previousPercent, autoCompactThreshold)) {
        compactedThisSession = true;
        triggerCompaction(ctx, autoCompactInstructions);
      }
    }

    // If usage drops back below the threshold (e.g. after a successful
    // compaction on a subsequent turn), allow future auto-compactions to
    // fire again. Otherwise a long session would only ever compact once.
    if (autoCompactThreshold !== null && current !== null && current < autoCompactThreshold) {
      compactedThisSession = false;
    }

    previousPercent = current;
  });

  // ── /context-budget command ─────────────────────────────────────────────────
  //
  // Subcommands:
  //   /context-budget            → same as preview
  //   /context-budget preview    → dump the exact advisory line that would be
  //                                appended to the next turn's system prompt,
  //                                together with current usage + thresholds +
  //                                auto-compact state so you can see which
  //                                tone band you're in and why.
  pi.registerCommand('context-budget', {
    description: 'Preview the context-budget advisory that would be injected into the next turn',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        preview: { description: 'Preview the advisory injected next turn' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_BUDGET_USAGE, 'info');
        return;
      }
      const sub = (args ?? '').trim().toLowerCase();
      if (sub !== '' && sub !== 'preview') {
        ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /context-budget [preview]`, 'warning');
        return;
      }

      const usage = ctx.getContextUsage();
      const preview = buildBudgetPreview(usage, options, autoCompactThreshold, compactedThisSession);
      ctx.ui.notify(preview, 'info');
    },
  });
}
