/**
 * Context-budget extension for pi — surfaces the model's own context-window
 * usage inside its system prompt and optionally triggers auto-compaction.
 *
 * Pi's footer already shows `N% left` to the user via `ctx.getContextUsage()`,
 * but the model doesn't see the footer — only the system prompt. Weaker
 * models (and some confident larger ones) will happily run a dozen 10KB
 * `read`s back to back without noticing they've burned through the window.
 * This extension closes the loop: each turn's system prompt ends with a
 * one-line advisory — "Context: 72% used (13k tokens left of 200k). Prefer
 * targeted `rg` / `read --offset / --limit` …" — so the model sees the
 * number AND the remediation in the same place.
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
 * re-compact every turn while sitting above the line. Off by default —
 * auto-compaction is a big hammer.
 *
 * Composes naturally with the statusline and todo / scratchpad
 * auto-injection: this extension's line is appended to whatever the
 * prior `before_agent_start` handlers produced, so the system prompt
 * picks up all of them.
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

import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';

import {
  type BudgetOptions,
  formatBudgetLine,
  formatTokens,
  shouldAutoCompact,
} from '../../../lib/node/pi/context-budget.ts';

const DEFAULT_MIN = 50;
const DEFAULT_WARN = 80;
const DEFAULT_CRITICAL = 90;

function parsePercentEnv(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > 100) return fallback;
  return n;
}

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
  if (process.env.PI_CONTEXT_BUDGET_DISABLED === '1') return;

  const options: BudgetOptions = {
    minPercent: parsePercentEnv('PI_CONTEXT_BUDGET_MIN_PERCENT', DEFAULT_MIN) ?? DEFAULT_MIN,
    warnPercent: parsePercentEnv('PI_CONTEXT_BUDGET_WARN_PERCENT', DEFAULT_WARN) ?? DEFAULT_WARN,
    criticalPercent: parsePercentEnv('PI_CONTEXT_BUDGET_CRITICAL_PERCENT', DEFAULT_CRITICAL) ?? DEFAULT_CRITICAL,
  };

  // `null` if unset → auto-compaction disabled.
  const autoCompactThreshold = parsePercentEnv('PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT', null);
  const autoCompactInstructions = process.env.PI_CONTEXT_BUDGET_AUTO_COMPACT_INSTRUCTIONS?.trim() || undefined;

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

  pi.on('before_agent_start', (event, ctx) => {
    const usage = ctx.getContextUsage();
    const line = formatBudgetLine(usage ?? null, options);
    if (!line) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
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
    handler: async (args, ctx) => {
      const sub = (args ?? '').trim().toLowerCase();
      if (sub !== '' && sub !== 'preview') {
        ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /context-budget [preview]`, 'warning');
        return;
      }

      const usage = ctx.getContextUsage();
      const lines: string[] = [];

      // Header: usage + thresholds
      if (!usage || usage.percent === null || usage.tokens === null) {
        lines.push('Context usage: (unknown — typically right after compaction, before the next LLM response)');
      } else {
        const tokensLeft = Math.max(0, usage.contextWindow - usage.tokens);
        lines.push(
          `Context usage: ${Math.round(usage.percent)}% — ${formatTokens(usage.tokens)} used, ${formatTokens(tokensLeft)} left of ${formatTokens(usage.contextWindow)} window`,
        );
      }
      lines.push(
        `Thresholds: min=${options.minPercent}%, warn=${options.warnPercent}%, critical=${options.criticalPercent}%`,
      );
      if (autoCompactThreshold !== null) {
        lines.push(
          `Auto-compact: edge-triggers at ${autoCompactThreshold}% (previous turn below, current at or above)` +
            (compactedThisSession
              ? ' — already fired this session, waiting for usage to dip back under threshold'
              : ''),
        );
      } else {
        lines.push('Auto-compact: disabled (set PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N to enable)');
      }
      lines.push('');

      // Preview block or "would be silent" message
      const line = formatBudgetLine(usage ?? null, options);
      if (!line) {
        const reason =
          !usage || usage.percent === null
            ? 'usage is unknown'
            : `usage ${Math.round(usage.percent)}% is below min-percent ${options.minPercent}%`;
        lines.push(`No advisory would be injected next turn (${reason}).`);
      } else {
        lines.push("Injected into the next turn's system prompt:");
        lines.push('');
        lines.push(line);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
