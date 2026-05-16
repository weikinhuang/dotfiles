/**
 * Statusline for pi — Claude Code–style 2-line footer.
 *
 * Replaces pi's built-in footer with a layout that mirrors
 * config/claude/statusline-command.sh:
 *
 *   [user#host cwd (branch) ctx% left $cost §sessid] model
 *    ↳ M(turn):↑in/↻ cached/↓out | S:↑in/↻ cached/↓out | ⚒ S:n(~bytes)
 *
 * Data sources (all available to extensions — no shell subprocess needed):
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
 * to the dotfiles-vendored `external/git-prompt.sh` — the same script that
 * powers `PS1` and `config/claude/statusline-command.sh`. Results are cached
 * per-cwd with a short TTL (see `./lib/git-prompt.ts`) and invalidated on
 * `footerData.onBranchChange`. If the helper can't be located or bash fails,
 * renders fall back to `footerData.getGitBranch()`.
 *
 * Linked worktree names (`git worktree add <name>`) are resolved by reading
 * `.git` / `.git/worktrees/<name>/commondir` directly via `./lib/git-worktree.ts`
 * — no subprocess required. Mirrors Claude Code's `workspace.git_worktree`
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

import { type AssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import {
  fetchGitSegmentAsync,
  GIT_SEGMENT_TTL_MS,
  type GitSegmentCacheEntry,
  resolveGitPromptScript,
} from '../../../lib/node/pi/git-prompt.ts';
import { resolveWorktreeInfo, type WorktreeInfo } from '../../../lib/node/pi/git-worktree.ts';
import { isBashAutoEnabled } from '../../../lib/node/pi/session-flags.ts';
import { getSessionSubagentAggregate } from '../../../lib/node/pi/subagent-aggregate.ts';
import { fmtCost, fmtSi } from '../../../lib/node/pi/token-format.ts';

/**
 * Resolved once at module load. `null` means we never found the helper — the
 * extension then always falls back to `footerData.getGitBranch()`.
 */
const GIT_PROMPT_SCRIPT_PATH: string | null = (() => {
  try {
    return resolveGitPromptScript(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
})();

/**
 * 256-color ANSI palette matching `config/claude/statusline-command.sh`, which
 * itself mirrors the dotfiles PS1 colors. Kept as raw SGR codes rather than
 * theme lookups so the statusline looks identical across pi themes and stays
 * visually consistent with the shell prompt.
 */
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PALETTE = {
  grey: '\x1b[38;5;244m',
  user: '\x1b[38;5;197m',
  host: '\x1b[38;5;208m',
  dir: '\x1b[38;5;142m',
  git: '\x1b[38;5;135m',
  worktree: '\x1b[38;5;173m',
  context: '\x1b[38;5;35m',
  token: '\x1b[38;5;245m',
  sessionToken: '\x1b[38;5;179m',
  subagent: '\x1b[38;5;73m',
  tool: '\x1b[38;5;214m',
  cost: '\x1b[38;5;108m',
  sessionId: '\x1b[38;5;244m',
  model: '\x1b[38;5;33m',
  persona: '\x1b[38;5;141m',
} as const;

const paint = (code: string, text: string): string => `${code}${text}${RESET}`;

/**
 * Wrap text in an OSC 8 hyperlink escape sequence.
 * Mirrors print_osc8_link() in statusline-command.sh.
 */
const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/**
 * Build a file:// URL for the cwd. Returns null when hyperlinks are disabled,
 * when we're on a remote SSH session (where file:// won't resolve on the
 * viewer's machine), or when cwd is empty. WSL paths are translated to the
 * host's filesystem view so clicks open in the Windows shell.
 */
function cwdFileUrl(cwd: string, hyperlinksEnabled: boolean): string | null {
  if (!hyperlinksEnabled || !cwd) return null;

  const wslDistro = process.env.WSL_DISTRO_NAME;
  if (wslDistro) {
    const mntMatch = cwd.match(/^\/mnt\/([a-z])(\/.*)?$/);
    if (mntMatch) {
      const drive = mntMatch[1]!.toUpperCase();
      const rest = mntMatch[2] ?? '';
      return `file:///${drive}:${rest}`;
    }
    return `file://wsl.localhost/${wslDistro}${cwd}`;
  }

  // Skip hyperlinks when the terminal is attached to a remote session — the
  // local viewer can't resolve file:// paths on the remote host.
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) return null;

  return `file://${cwd}`;
}

interface Aggregates {
  sessionIn: number;
  sessionCacheRead: number;
  sessionCacheWrite: number;
  sessionOut: number;
  sessionCostTotal: number;
  turns: number;
  lastIn: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  lastOut: number;
  toolCalls: number;
  toolResultBytes: number;
}

function aggregate(branch: unknown): Aggregates {
  const out: Aggregates = {
    sessionIn: 0,
    sessionCacheRead: 0,
    sessionCacheWrite: 0,
    sessionOut: 0,
    sessionCostTotal: 0,
    turns: 0,
    lastIn: 0,
    lastCacheRead: 0,
    lastCacheWrite: 0,
    lastOut: 0,
    toolCalls: 0,
    toolResultBytes: 0,
  };

  // Defensive guard: if pi's session manager ever returns a non-iterable,
  // a silent `for...of` no-op would mask the problem. Bail explicitly.
  if (!Array.isArray(branch)) return out;

  for (const rawEntry of branch) {
    const entry = rawEntry as { type?: string; message?: { role?: string } };
    if (entry?.type !== 'message' || !entry.message) continue;

    if (entry.message.role === 'assistant') {
      const m = entry.message as AssistantMessage;
      const u = m.usage;
      if (u) {
        out.sessionIn += u.input ?? 0;
        out.sessionCacheRead += u.cacheRead ?? 0;
        out.sessionCacheWrite += u.cacheWrite ?? 0;
        out.sessionOut += u.output ?? 0;
        out.sessionCostTotal += u.cost?.total ?? 0;
        out.lastIn = u.input ?? 0;
        out.lastCacheRead = u.cacheRead ?? 0;
        out.lastCacheWrite = u.cacheWrite ?? 0;
        out.lastOut = u.output ?? 0;
      }
      for (const c of m.content) if (c.type === 'toolCall') out.toolCalls++;
    } else if (entry.message.role === 'user') {
      // Turns = user prompts submitted (matches M(N) semantics in the bash script,
      // which counts user-authored turns).
      out.turns++;
    } else if (entry.message.role === 'toolResult') {
      const m = entry.message as ToolResultMessage;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'text') out.toolResultBytes += c.text?.length ?? 0;
        }
      }
    }
  }

  return out;
}

export default function extension(pi: ExtensionAPI): void {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER || process.env.USERNAME || 'user';
    }
  })();
  const host = (() => {
    try {
      return hostname().split('.')[0] ?? 'host';
    } catch {
      return 'host';
    }
  })();

  const disabled = process.env.PI_STATUSLINE_DISABLED === '1';
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
          scriptPath: GIT_PROMPT_SCRIPT_PATH as string,
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
        // Prefer the decorated value when we have one, even if stale — it's a
        // better approximation than the plain branch while the refetch runs.
        return entry?.value || fallback;
      };

      // Per-session cache of worktree info keyed by cwd. resolveWorktreeInfo
      // is pure fs (existsSync / readFileSync on a handful of tiny files) so
      // caching is mostly about avoiding log spam during rapid repaints —
      // there's no network or subprocess cost to pay. `null` is cached too,
      // so non-git cwds don't re-stat `.git` on every keystroke.
      const worktreeCache = new Map<string, WorktreeInfo | null>();

      const unsubBranch = footerData.onBranchChange(() => {
        // HEAD (or reftable) moved — every cached decorated segment is now
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
            // eslint-disable-next-line no-use-before-define -- `renderFooter` is a hoisted function declaration below, split out so the outer render can wrap it in a single try/catch without interleaving control flow.
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
      // before the returned object to keep ESLint's
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
          line1Parts.push(' ', paint(PALETTE.tool, '⚡'));
        }
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
          // Per-turn R = cache-hit ratio for the most recent assistant message;
          // signals whether that specific turn hit the prompt cache.
          const lastCacheDenom = agg.lastIn + agg.lastCacheRead;
          const lastRatioSeg =
            lastCacheDenom > 0 ? ` R ${Math.round((agg.lastCacheRead / lastCacheDenom) * 100)}%` : '';
          line2Parts.push(
            paint(
              PALETTE.token,
              `${label}:↑${fmtSi(agg.lastIn)}/↻ ${fmtSi(agg.lastCacheRead)}/↓${fmtSi(agg.lastOut)}${lastRatioSeg}`,
            ),
          );
        }

        if (agg.sessionIn + agg.sessionCacheRead + agg.sessionOut > 0) {
          // W = cache write tokens; only shown when non-zero. For models that write a lot
          // to the prompt cache (Anthropic, Bedrock) this surfaces the cost delta of the
          // first vs. subsequent turns.
          const writeSeg = agg.sessionCacheWrite > 0 ? `/W ${fmtSi(agg.sessionCacheWrite)}` : '';
          // R = cache-hit ratio (cacheRead / (input + cacheRead)). A quick indicator that
          // prompt caching is actually engaging; near-zero means the cache is missing.
          const cacheDenom = agg.sessionIn + agg.sessionCacheRead;
          const ratioSeg = cacheDenom > 0 ? ` R ${Math.round((agg.sessionCacheRead / cacheDenom) * 100)}%` : '';
          line2Parts.push(
            paint(
              PALETTE.sessionToken,
              `S:↑${fmtSi(agg.sessionIn)}/↻ ${fmtSi(agg.sessionCacheRead)}${writeSeg}/↓${fmtSi(agg.sessionOut)}${ratioSeg}`,
            ),
          );
        }

        if (agg.toolCalls > 0) {
          const bytesSuffix = agg.toolResultBytes > 0 ? `(~${fmtSi(agg.toolResultBytes / 4)})` : '';
          line2Parts.push(paint(PALETTE.tool, `⚒ S:${agg.toolCalls}${bytesSuffix}`));
        }

        // Σ(N):… — session-total subagent usage (count, tokens, cost)
        // populated by the subagent extension through the shared
        // getSessionSubagentAggregate() singleton. Mirrors the M(…)/S:
        // shape so the three aggregates read consistently. Shown only
        // when at least one child has completed this session; the
        // per-child live status stays on line 3.
        const subAgg = getSessionSubagentAggregate().snapshot();
        if (subAgg.count > 0) {
          const label = subAgg.failures > 0 ? `Σ(${subAgg.count}·${subAgg.failures}✗)` : `Σ(${subAgg.count})`;
          const writeSeg = subAgg.cacheWrite > 0 ? `/W ${fmtSi(subAgg.cacheWrite)}` : '';
          const cacheDenom = subAgg.input + subAgg.cacheRead;
          const ratioSeg = cacheDenom > 0 ? ` R ${Math.round((subAgg.cacheRead / cacheDenom) * 100)}%` : '';
          const costSeg = subAgg.cost > 0 ? ` ${fmtCost(subAgg.cost)}` : '';
          line2Parts.push(
            paint(
              PALETTE.subagent,
              `${label}:↑${fmtSi(subAgg.input)}/↻ ${fmtSi(subAgg.cacheRead)}${writeSeg}/↓${fmtSi(subAgg.output)}${ratioSeg}${costSeg}`,
            ),
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
}
