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
 * Uses only semantic theme colors so it adapts to any pi theme.
 *
 * Environment variables:
 *   PI_STATUSLINE_DISABLED=1       → restore pi's built-in footer
 *   PI_STATUSLINE_DISABLE_HYPERLINKS=1
 *     or DOT_DISABLE_HYPERLINKS=1  → skip OSC8 hyperlinks (same knob as the
 *                                   Claude Code script)
 */

import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';
import { type AssistantMessage, type ToolResultMessage } from '@mariozechner/pi-ai';
import { type ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { isBashAutoEnabled } from './lib/session-flags.ts';

const fmtSi = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
};

const fmtCost = (c: number): string => `$${c.toFixed(3)}`;

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
  sessionOut: number;
  sessionCostTotal: number;
  turns: number;
  lastIn: number;
  lastCacheRead: number;
  lastOut: number;
  toolCalls: number;
  toolResultBytes: number;
}

function aggregate(branch: readonly unknown[]): Aggregates {
  const out: Aggregates = {
    sessionIn: 0,
    sessionCacheRead: 0,
    sessionOut: 0,
    sessionCostTotal: 0,
    turns: 0,
    lastIn: 0,
    lastCacheRead: 0,
    lastOut: 0,
    toolCalls: 0,
    toolResultBytes: 0,
  };

  for (const rawEntry of branch) {
    const entry = rawEntry as { type?: string; message?: { role?: string } };
    if (entry?.type !== 'message' || !entry.message) continue;

    if (entry.message.role === 'assistant') {
      const m = entry.message as AssistantMessage;
      const u = m.usage;
      if (u) {
        out.sessionIn += u.input ?? 0;
        out.sessionCacheRead += u.cacheRead ?? 0;
        out.sessionOut += u.output ?? 0;
        out.sessionCostTotal += u.cost?.total ?? 0;
        out.lastIn = u.input ?? 0;
        out.lastCacheRead = u.cacheRead ?? 0;
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

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => unsubBranch(),
        invalidate(): void {
          // no-op: render() recomputes everything from ctx on each call
        },
        render(width: number): string[] {
          // --- gather data ---
          const cwdShort = basename(ctx.cwd) || ctx.cwd;
          const branch = footerData.getGitBranch();
          const ctxUsage = ctx.getContextUsage();
          const remainingPct = ctxUsage?.percent != null ? Math.max(0, Math.min(100, 100 - ctxUsage.percent)) : null;
          const modelId = ctx.model?.id ?? 'no-model';
          const sessionId = ctx.sessionManager.getSessionId?.();
          const shortSessionId = sessionId ? sessionId.slice(0, 8) : '';

          const agg = aggregate(ctx.sessionManager.getBranch());

          const cwdUrl = cwdFileUrl(ctx.cwd, hyperlinksEnabled);
          const cwdStyled = theme.fg('mdListBullet', cwdShort);
          const cwdSegment = cwdUrl ? osc8(cwdUrl, cwdStyled) : cwdStyled;

          // --- line 1: [user#host cwd (branch) ctx% $cost §sessid] model ---
          const line1Parts: string[] = [
            theme.bold(theme.fg('dim', '[')),
            theme.fg('error', user),
            theme.fg('dim', '#'),
            theme.fg('warning', host),
            ' ',
            cwdSegment,
          ];

          if (branch) {
            line1Parts.push(theme.fg('mdLink', ` (${branch})`));
          }
          if (remainingPct != null) {
            line1Parts.push(theme.fg('success', ` ${remainingPct.toFixed(0)}% left`));
          }
          if (agg.sessionCostTotal > 0) {
            line1Parts.push(theme.fg('toolTitle', ` ${fmtCost(agg.sessionCostTotal)}`));
          }
          if (shortSessionId) {
            line1Parts.push(theme.fg('muted', ` §${shortSessionId}`));
          }

          line1Parts.push(theme.bold(theme.fg('dim', ']')));
          // Bash-auto indicator: when /bash-auto is ON, flag the footer so
          // it's obvious commands will run without prompting. State is
          // owned by bash-permissions.ts and read via ./lib/session-flags.ts.
          if (isBashAutoEnabled()) {
            line1Parts.push(' ', theme.fg('warning', '⚡'));
          }
          line1Parts.push(' ', theme.fg('accent', modelId));

          // --- line 2: ↳ M:↑/↻/↓ | S:↑/↻/↓ | ⚒ S:n(~bytes) ---
          const parts: string[] = [];

          if (agg.lastIn + agg.lastCacheRead + agg.lastOut > 0) {
            const label = agg.turns > 0 ? `M(${agg.turns})` : 'M';
            parts.push(
              theme.fg('dim', `${label}:↑${fmtSi(agg.lastIn)}/↻ ${fmtSi(agg.lastCacheRead)}/↓${fmtSi(agg.lastOut)}`),
            );
          }

          if (agg.sessionIn + agg.sessionCacheRead + agg.sessionOut > 0) {
            parts.push(
              theme.fg('text', `S:↑${fmtSi(agg.sessionIn)}/↻ ${fmtSi(agg.sessionCacheRead)}/↓${fmtSi(agg.sessionOut)}`),
            );
          }

          if (agg.toolCalls > 0) {
            const bytesSuffix = agg.toolResultBytes > 0 ? `(~${fmtSi(agg.toolResultBytes / 4)})` : '';
            parts.push(theme.fg('warning', `⚒ S:${agg.toolCalls}${bytesSuffix}`));
          }

          const sep = theme.fg('dim', ' | ');
          const arrow = theme.fg('muted', ' ↳ ');

          const line1 = line1Parts.join('');
          const lines: string[] = [truncateToWidth(line1, width)];
          if (parts.length > 0) {
            const line2 = arrow + parts.join(sep);
            // Pad to width so render doesn't leave stale glyphs when the line shrinks.
            const pad = Math.max(0, width - visibleWidth(line2));
            lines.push(truncateToWidth(line2 + ' '.repeat(pad), width));
          }
          return lines;
        },
      };
    });
  });

  // Refresh the footer whenever session state changes so tokens/cost/turns update live.
  const refresh = (_event: unknown, ctx: { ui: { requestRender?: () => void } } & Record<string, unknown>): void => {
    // Extensions don't have direct access to tui.requestRender, but pi re-renders on
    // message/turn events already. Still, touching setStatus(undefined) is a safe no-op
    // that guarantees a repaint on hosts that debounce aggressively.
    (ctx as { ui: { setStatus: (k: string, v: string | undefined) => void } }).ui.setStatus('statusline', undefined);
  };
  pi.on('message_end', refresh);
  pi.on('turn_end', refresh);
}
