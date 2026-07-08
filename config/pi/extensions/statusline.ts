/**
 * Statusline for pi - Claude Code–style 2-line footer.
 *
 * Replaces pi's built-in footer with a layout that mirrors
 * config/claude/statusline-command.sh:
 *
 *   [user#host cwd (branch) ctx% left $cost §sessid] model
 *    ↳ M(turn):↑in/↻ cached/↓out | S:↑in/↻ cached/↓out | ⚒ S:n(~bytes)
 *
 * Data sources (all available to extensions - no shell subprocess needed):
 *   - ctx.getContextUsage()        → tokens / percent of context window
 *   - ctx.sessionManager           → per-message usage, session id, tool results
 *   - ctx.model                    → current model id
 *   - ctx.cwd                      → working directory
 *   - footerData.getGitBranch()    → live git branch with change watcher
 *
 * Colors are hard-coded 256-color ANSI codes matching the dotfiles PS1 /
 * `config/claude/statusline-command.sh` palette (see PALETTE below). They
 * intentionally bypass pi's theme so the statusline looks identical across
 * themes and matches the interactive shell prompt.
 *
 * For branch decoration (dirty/staged/stash/untracked/upstream) we shell out
 * to the dotfiles-vendored `external/git-prompt.sh` - the same script that
 * powers `PS1` and `config/claude/statusline-command.sh`. Results are cached
 * per-cwd with a short TTL (see `./lib/git-prompt.ts`) and invalidated on
 * `footerData.onBranchChange`. If the helper can't be located or bash fails,
 * renders fall back to `footerData.getGitBranch()`.
 *
 * Linked worktree names (`git worktree add <name>`) are resolved by reading
 * `.git` / `.git/worktrees/<name>/commondir` directly via `./lib/git-worktree.ts`
 * - no subprocess required. Mirrors Claude Code's `workspace.git_worktree`
 * field and renders ` ⎇ <name>` after the branch segment.
 *
 * Environment variables:
 *   PI_STATUSLINE_DISABLED=1       → restore pi's built-in footer
 *   PI_STATUSLINE_DISABLE_HYPERLINKS=1
 *     or DOT_DISABLE_HYPERLINKS=1  → skip OSC8 hyperlinks (same knob as the
 *                                   Claude Code script)
 *   PI_STATUSLINE_DISABLE_GIT_PROMPT=1
 *                                  → skip git-prompt.sh; always use pi's
 *                                    plain `footerData.getGitBranch()`
 */

import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import {
  fetchGitSegmentAsync,
  GIT_SEGMENT_TTL_MS,
  type GitSegmentCacheEntry,
  resolveGitPromptScript,
} from '../../../lib/node/pi/git-prompt.ts';
import { resolveWorktreeInfo, type WorktreeInfo } from '../../../lib/node/pi/git-worktree.ts';
import { getSandboxState, isBashAutoEnabled } from '../../../lib/node/pi/session-flags.ts';
import { aggregate } from '../../../lib/node/pi/statusline/aggregate.ts';
import {
  BOLD,
  cwdFileUrl,
  osc8,
  paint,
  PALETTE,
  RESET,
  renderSandboxBadge,
} from '../../../lib/node/pi/statusline/segments.ts';
import { getSessionSubagentAggregate } from '../../../lib/node/pi/subagent/aggregate.ts';
import { fmtCost, fmtSi, formatUsageLine } from '../../../lib/node/pi/token-format.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

/**
 * Resolved once at module load. `null` means we never found the helper - the
 * extension then always falls back to `footerData.getGitBranch()`.
 */
const GIT_PROMPT_SCRIPT_PATH: string | null = (() => {
  try {
    return resolveGitPromptScript(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
})();

export default function extension(pi: ExtensionAPI): void {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? process.env.USERNAME ?? 'user';
    }
  })();
  const host = (() => {
    try {
      return hostname().split('.')[0] ?? 'host';
    } catch {
      return 'host';
    }
  })();

  const disabled = envTruthy(process.env.PI_STATUSLINE_DISABLED);
  if (disabled) return;

  const hyperlinksEnabled =
    process.env.PI_STATUSLINE_DISABLE_HYPERLINKS !== '1' && process.env.DOT_DISABLE_HYPERLINKS !== '1';

  const gitPromptEnabled = process.env.PI_STATUSLINE_DISABLE_GIT_PROMPT !== '1' && GIT_PROMPT_SCRIPT_PATH !== null;

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setFooter((tui, _theme, footerData) => {
      // Per-session cache of decorated git segments. Keyed by cwd so that
      // switching worktrees inside a long-running session doesn't bleed
      // stale values across directories. Invalidated on branch change and
      // expired via GIT_SEGMENT_TTL_MS.
      const gitCache = new Map<string, GitSegmentCacheEntry>();
      let disposed = false;

      const scheduleGitFetch = (cwd: string): void => {
        if (!gitPromptEnabled || disposed || !cwd) return;
        const entry: GitSegmentCacheEntry = gitCache.get(cwd) ?? { value: '', ts: 0, inFlight: false };
        if (entry.inFlight) return;
        entry.inFlight = true;
        gitCache.set(cwd, entry);
        void fetchGitSegmentAsync({
          // GIT_PROMPT_SCRIPT_PATH is non-null when gitPromptEnabled.
          scriptPath: GIT_PROMPT_SCRIPT_PATH,
          cwd,
        }).then((value) => {
          entry.inFlight = false;
          entry.ts = Date.now();
          entry.value = value;
          if (!disposed) tui.requestRender();
        });
      };

      const getGitSegment = (cwd: string, fallbackBranch: string | null): string => {
        const fallback = fallbackBranch ? ` (${fallbackBranch})` : '';
        if (!gitPromptEnabled || !cwd) return fallback;
        const entry = gitCache.get(cwd);
        const fresh = entry && Date.now() - entry.ts < GIT_SEGMENT_TTL_MS;
        if (!fresh) scheduleGitFetch(cwd);
        // Prefer the decorated value when we have one, even if stale - it's a
        // better approximation than the plain branch while the refetch runs.
        return entry?.value ?? fallback;
      };

      // Per-session cache of worktree info keyed by cwd. resolveWorktreeInfo
      // is pure fs (existsSync / readFileSync on a handful of tiny files) so
      // caching is mostly about avoiding log spam during rapid repaints -
      // there's no network or subprocess cost to pay. `null` is cached too,
      // so non-git cwds don't re-stat `.git` on every keystroke.
      const worktreeCache = new Map<string, WorktreeInfo | null>();

      const unsubBranch = footerData.onBranchChange(() => {
        // HEAD (or reftable) moved - every cached decorated segment is now
        // suspect. Stamp them stale so the next render kicks off a refetch.
        for (const entry of gitCache.values()) entry.ts = 0;
        // Worktree metadata can also shift (e.g. `git worktree add` / `remove`
        // touches the `.git/worktrees/*` tree, which the branch watcher
        // already surfaces). Drop the cache so the next render rediscovers.
        worktreeCache.clear();
        tui.requestRender();
      });

      const getWorktreeInfo = (cwd: string): WorktreeInfo | null => {
        if (!cwd) return null;
        if (worktreeCache.has(cwd)) return worktreeCache.get(cwd) ?? null;
        const info = resolveWorktreeInfo(cwd);
        worktreeCache.set(cwd, info);
        return info;
      };

      return {
        dispose: () => {
          disposed = true;
          unsubBranch();
        },
        invalidate(): void {
          // no-op: render() recomputes everything from ctx on each call
        },
        render(width: number): string[] {
          // Defensive wrap: `ctx.ui.setFooter` captures the outer `ctx`
          // from `session_start`, but pi can invalidate that captured
          // ctx at any time (session replacement, teardown in `-p`/
          // `--no-session` mode, reload). Any `ctx.<prop>` access on a
          // stale ctx throws `"This extension ctx is stale after
          // session replacement or reload."`, which pi surfaces on
          // stdout and clobbers the assistant output in print mode.
          // Returning `[]` here gracefully degrades to pi's built-in
          // footer (or no footer) for that frame instead of crashing.
          if (disposed) return [];
          try {
            // oxlint-disable-next-line no-use-before-define -- `renderFooter` is a hoisted function declaration below, split out so the outer render can wrap it in a single try/catch without interleaving control flow.
            return renderFooter(width);
          } catch {
            // Mark disposed on any render error so scheduled git fetches
            // and subsequent renders also short-circuit cleanly.
            disposed = true;
            return [];
          }
        },
      };

      // Render body extracted so the outer `render` can wrap it in
      // one try/catch without interleaving control flow. Declared
      // before the returned object to keep Oxlint's
      // `no-use-before-define` happy (function declarations hoist
      // regardless, but the lint rule inspects source order).
      function renderFooter(width: number): string[] {
        // --- gather data ---
        const cwdShort = basename(ctx.cwd) || ctx.cwd;
        const branch = footerData.getGitBranch();
        const ctxUsage = ctx.getContextUsage();
        const remainingPct = ctxUsage?.percent != null ? Math.max(0, Math.min(100, 100 - ctxUsage.percent)) : null;
        const modelId = ctx.model?.name ?? ctx.model?.id ?? 'no-model';
        // Only models with `reasoning: true` expose a meaningful thinking level;
        // everything else reports "off" regardless of pi.getThinkingLevel().
        const thinkingLevel = ctx.model?.reasoning ? pi?.getThinkingLevel() : undefined;
        const sessionId = ctx.sessionManager.getSessionId?.();
        const shortSessionId = sessionId ? sessionId.slice(0, 8) : '';

        const agg = aggregate(ctx.sessionManager.getBranch());

        const cwdUrl = cwdFileUrl(ctx.cwd, hyperlinksEnabled);
        const cwdStyled = paint(PALETTE.dir, cwdShort);
        const cwdSegment = cwdUrl ? osc8(cwdUrl, cwdStyled) : cwdStyled;

        // --- line 1: [user#host cwd (branch) ctx% $cost §sessid] model ---
        const line1Parts: string[] = [
          `${BOLD}${PALETTE.grey}[${RESET}`,
          paint(PALETTE.user, user),
          paint(PALETTE.grey, '#'),
          paint(PALETTE.host, host),
          ' ',
          cwdSegment,
        ];

        if (branch || gitPromptEnabled) {
          const gitSeg = getGitSegment(ctx.cwd, branch);
          if (gitSeg) {
            line1Parts.push(paint(PALETTE.git, gitSeg));
          }
        }
        // Worktree badge (` ⎇ <name>`), mirroring Claude's workspace.git_worktree
        // segment. Only shown inside linked worktrees (`git worktree add …`); main
        // worktrees and non-git cwds render nothing.
        const worktree = getWorktreeInfo(ctx.cwd);
        if (worktree?.worktreeName) {
          line1Parts.push(paint(PALETTE.worktree, ` ⎇ ${worktree.worktreeName}`));
        }
        if (remainingPct != null) {
          line1Parts.push(paint(PALETTE.context, ` ${remainingPct.toFixed(0)}% left`));
        }
        if (agg.sessionCostTotal > 0) {
          line1Parts.push(paint(PALETTE.cost, ` ${fmtCost(agg.sessionCostTotal)}`));
        }
        if (shortSessionId) {
          line1Parts.push(paint(PALETTE.sessionId, ` §${shortSessionId}`));
        }

        line1Parts.push(`${BOLD}${PALETTE.grey}]${RESET}`);
        // Bash-auto indicator: when /bash-auto is ON, flag the footer so
        // it's obvious commands will run without prompting. State is
        // owned by bash-permissions.ts and read via ./lib/session-flags.ts.
        if (isBashAutoEnabled()) {
          line1Parts.push(' ', paint(PALETTE.tool, '\u26a1'));
        }
        // Sandbox indicator: published by sandbox.ts via
        // session-flags.setSandboxState. Rendered adjacent to the
        // \u26a1 auto-mode glyph (so `\u26a1 \ud83d\udee1\ufe0f` reads "defense-in-depth on")
        // and tinted amber for `identity` (degraded) / red for
        // `env-disabled`. The badge is hidden for the `bypassed` and
        // `off` states - see renderSandboxBadge for the rationale.
        const sandboxBadge = renderSandboxBadge(getSandboxState().mode);
        if (sandboxBadge) line1Parts.push(' ', sandboxBadge);
        line1Parts.push(' ', paint(PALETTE.model, modelId));
        if (thinkingLevel) {
          // Matches pi's built-in footer (`<model> • <level>` / `<model> • thinking off`)
          // but rendered in grey so the model id stays the prominent element.
          line1Parts.push(paint(PALETTE.grey, ` • ${thinkingLevel}`));
        }
        // `persona:<name>` segment, sourced from the persona extension's
        // setStatus(STATUS_KEY = 'persona', ...). Pulled onto line 1 (after
        // thinkingLevel) instead of the alphabetised line-3 strip so the
        // active persona stays visible alongside the model + thinking hints
        // it actually overrides.
        const personaStatus = footerData.getExtensionStatuses().get('persona');
        if (personaStatus) {
          line1Parts.push(paint(PALETTE.grey, ' • '), paint(PALETTE.persona, personaStatus.replace(/[\r\n\t]+/g, ' ')));
        }

        // --- line 2: ↳ M:↑/↻/↓ | S:↑/↻/↓ | ⚒ S:n(~bytes) ---
        const line2Parts: string[] = [];

        if (agg.lastIn + agg.lastCacheRead + agg.lastOut > 0) {
          const label = agg.turns > 0 ? `M(${agg.turns})` : 'M';
          line2Parts.push(
            paint(
              PALETTE.token,
              `${label}:${formatUsageLine({ input: agg.lastIn, cacheRead: agg.lastCacheRead, output: agg.lastOut }, { includeRatio: true })}`,
            ),
          );
        }

        if (agg.sessionIn + agg.sessionCacheRead + agg.sessionOut > 0) {
          line2Parts.push(
            paint(
              PALETTE.sessionToken,
              `S:${formatUsageLine(
                {
                  input: agg.sessionIn,
                  cacheRead: agg.sessionCacheRead,
                  cacheWrite: agg.sessionCacheWrite,
                  output: agg.sessionOut,
                },
                { includeRatio: true },
              )}`,
            ),
          );
        }

        if (agg.toolCalls > 0) {
          const bytesSuffix = agg.toolResultBytes > 0 ? `(~${fmtSi(agg.toolResultBytes / 4)})` : '';
          line2Parts.push(paint(PALETTE.tool, `⚒ S:${agg.toolCalls}${bytesSuffix}`));
        }

        // Σ(N):… - session-total subagent usage (count, tokens, cost)
        // populated by the subagent extension through the shared
        // getSessionSubagentAggregate() singleton. Mirrors the M(…)/S:
        // shape so the three aggregates read consistently. Shown only
        // when at least one child has completed this session; the
        // per-child live status stays on line 3.
        const subAgg = getSessionSubagentAggregate().snapshot();
        if (subAgg.count > 0) {
          const label = subAgg.failures > 0 ? `Σ(${subAgg.count}·${subAgg.failures}✗)` : `Σ(${subAgg.count})`;
          const costSeg = subAgg.cost > 0 ? ` ${fmtCost(subAgg.cost)}` : '';
          line2Parts.push(
            paint(PALETTE.subagent, `${label}:${formatUsageLine(subAgg, { includeRatio: true })}${costSeg}`),
          );
        }

        // --- line 3: other extensions' statuses (preset, working-indicator, …) ---
        // setFooter() replaces pi's built-in footer, which would otherwise render
        // footerData.getExtensionStatuses(); append them here so ctx.ui.setStatus(...)
        // from other extensions stays visible. `persona` is consumed on line 1 above
        // and excluded here to avoid double-rendering.
        const line3Parts = [...footerData.getExtensionStatuses().entries()]
          .filter(([k]) => k !== 'persona')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, v]) => v.replace(/[\r\n\t]+/g, ' '));

        const sep = paint(PALETTE.grey, ' | ');
        const arrow = paint(PALETTE.grey, ' ↳ ');

        const line1 = line1Parts.join('');
        const lines: string[] = [truncateToWidth(line1, width)];
        if (line2Parts.length > 0) {
          const line2 = arrow + line2Parts.join(sep);
          // Pad to width so render doesn't leave stale glyphs when the line shrinks.
          const pad = Math.max(0, width - visibleWidth(line2));
          lines.push(truncateToWidth(line2 + ' '.repeat(pad), width));
        }
        if (line3Parts.length > 0) {
          const line3 = line3Parts.join(' ');
          const pad = Math.max(0, width - visibleWidth(line3));
          lines.push(truncateToWidth(line3 + ' '.repeat(pad), width));
        }
        return lines;
      }
    });
  });

  // Refresh the footer whenever session state changes so tokens/cost/turns update live.
  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    // Extensions don't have direct access to tui.requestRender, but pi re-renders on
    // message/turn events already. Still, touching setStatus(undefined) is a safe no-op
    // that guarantees a repaint on hosts that debounce aggressively.
    ctx.ui.setStatus('statusline', undefined);
  };
  pi.on('message_end', refresh);
  pi.on('turn_end', refresh);

  pi.on('session_shutdown', (_event, ctx) => {
    // Release the mounted footer + status slot. The footer factory
    // captures the session_start `ctx` and owns a branch-change
    // subscription it tears down via its own `dispose()` when pi
    // replaces the component; handing the footer back to undefined
    // triggers that disposal and stops stale renders bleeding across a
    // /reload. The next session_start re-installs a fresh footer.
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setFooter(undefined);
      ctx.ui.setStatus('statusline', undefined);
    } catch {
      // best-effort: shutdown must never throw.
    }
  });
}
