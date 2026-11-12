/**
 * Statusline for opencode, ported from the pi `statusline` extension
 * (config/pi/extensions/statusline.ts). See ./README.md.
 *
 * Appends to the native prompt footer (`prompt.footer.status`, right after
 * the `<dir>:<branch>` label) instead of replacing it, and shows only what
 * the native footer lacks: `__git_ps1` decoration, linked-worktree name,
 * prompt-cache hit ratio, cache-write tokens, tool-call count, short session
 * id, and `user#host`. Segments drop by priority to fit the row.
 *
 * Git state comes from the vendored external/git-prompt.sh, cached per
 * directory and refreshed on events (tool / shell / turn end, HEAD changes,
 * terminal focus), never by busy polling. Logic lives in
 * lib/node/opencode/statusline{,-git}.ts.
 */

import { homedir, hostname, userInfo } from 'node:os';

import { Plugin } from '@opencode/plugin/tui';
import { type BoxRenderable } from '@opentui/core';
import { type JSX, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';

import { resolveGitPromptScript } from '../../../../lib/node/pi/git-prompt.ts';
import {
  createKeyedRefresher,
  formatGitDecoration,
  type GitSnapshot,
  readGitSnapshot,
} from '../../../../lib/node/opencode/statusline-git.ts';
import {
  buildSegments,
  cellWidth,
  countToolCalls,
  fitSegments,
  lastStepUsage,
  LOCATION_RESERVE,
  nativeFooterWidth,
  nativeUsageText,
  resolveStatuslineConfig,
  SEGMENT_SEPARATOR,
  type SegmentTone,
  statuslineBudget,
} from '../../../../lib/node/opencode/statusline.ts';

/** Coalesces bursts of tool / fs events into one `__git_ps1` run. */
const GIT_DEBOUNCE_MS = 400;

const REFRESH_EVENTS = [
  'vcs.branch.updated',
  'filesystem.changed',
  'session.tool.success',
  'session.tool.failed',
  'session.shell.ended',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
] as const;

function userHost(): string {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? 'user';
  }
  let host: string;
  try {
    host = hostname().split('.')[0] ?? 'host';
  } catch {
    host = 'host';
  }
  return `${user}#${host}`;
}

function abbreviateHome(dir: string, home: string): string {
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

export default Plugin.define({
  id: 'dotfiles.statusline',
  setup(context) {
    const config = resolveStatuslineConfig(context.options, process.env);
    if (!config.enabled || config.segments.length === 0) return;

    const wantsGit = config.segments.includes('git') || config.segments.includes('worktree');
    const scriptPath = config.gitPrompt ? resolveGitPromptScript(import.meta.dirname) : null;
    const user = userHost();
    const home = homedir();

    // Per-directory git snapshots; `gitVersion` is the reactive edge.
    const snapshots = new Map<string, GitSnapshot>();
    const [gitVersion, setGitVersion] = createSignal(0);
    const refresher = createKeyedRefresher<GitSnapshot>({
      fetch: (dir) => readGitSnapshot(dir, scriptPath),
      onValue: (dir, value) => {
        snapshots.set(dir, value);
        setGitVersion((v) => v + 1);
      },
      debounceMs: GIT_DEBOUNCE_MS,
    });

    const cleanups: (() => void)[] = [() => refresher.dispose()];
    if (wantsGit) {
      for (const type of REFRESH_EVENTS) cleanups.push(context.data.on(type, () => refresher.requestAll()));
      const onFocus = (): void => refresher.requestAll();
      context.renderer.on('focus', onFocus);
      cleanups.push(() => context.renderer.off('focus', onFocus));
      if (config.gitIntervalSeconds > 0) {
        const timer = setInterval(() => refresher.requestAll(), config.gitIntervalSeconds * 1000);
        cleanups.push(() => clearInterval(timer));
      }
    }

    const theme = context.theme;
    const toneColor = (tone: SegmentTone): typeof theme.text.muted => {
      switch (tone) {
        case 'git':
          return theme.hue.accent[500];
        case 'worktree':
          return theme.hue.interactive[400];
        case 'good':
          return theme.text.feedback.success.base;
        case 'warn':
          return theme.text.feedback.warning.base;
        default:
          return theme.text.muted;
      }
    };

    function Statusline(props: { sessionID?: string; mode: 'normal' | 'shell'; showDetails: boolean }): JSX.Element {
      const session = createMemo(() => (props.sessionID ? context.data.session.get(props.sessionID) : undefined));
      const location = createMemo(() => session()?.location ?? context.location ?? context.data.location.default());
      const directory = createMemo(() => location().directory);

      createEffect(() => {
        if (wantsGit) refresher.track(directory());
      });

      const usage = createMemo(() => {
        const id = props.sessionID;
        if (!id) return undefined;
        const messages = context.data.session.message.list(id);
        return {
          last: lastStepUsage(messages, session()?.revert?.messageID),
          toolCalls: countToolCalls(messages),
        };
      });

      const segments = createMemo(() => {
        gitVersion();
        const snapshot = snapshots.get(directory());
        const info = session();
        return buildSegments(
          {
            git: formatGitDecoration(snapshot?.decoration ?? null, config.gitBranch),
            worktree: snapshot?.worktree,
            sessionID: props.sessionID,
            last: usage()?.last,
            session: info?.tokens,
            toolCalls: usage()?.toolCalls,
            user,
          },
          config.segments,
        );
      });

      // Budget: an absolutely positioned probe measures the host footer row
      // without joining its flex layout; the native footer (mirrored from its
      // source) and the location label are reserved, and our box stays
      // content-sized so the native label keeps the row's free space.
      const [rowWidth, setRowWidth] = createSignal(0);
      const onRowSize = function (this: BoxRenderable): void {
        const w = this.width;
        queueMicrotask(() => setRowWidth(w));
      };
      const dimensions = useTerminalDimensions();
      const budget = createMemo(() => {
        const id = props.sessionID;
        const info = session();
        const last = usage()?.last;
        let contextLimit: number | undefined;
        if (info?.model && last) {
          const ref = info.model;
          const models = context.data.location.model.list(info.location) ?? [];
          contextLimit = models.find((m) => m.providerID === ref.providerID && m.id === ref.id)?.limit.context;
        }
        const nativeWidth = nativeFooterWidth({
          width: dimensions().width,
          usage: id ? nativeUsageText({ last, contextLimit, cost: context.data.session.cost(id) }) : '',
          shortcut: context.keymap.shortcuts('command.palette.show')[0],
          agentShortcut: context.keymap.shortcuts('agent.cycle')[0],
        });
        let locationWidth = LOCATION_RESERVE;
        if (!id || context.data.session.status(id) === 'idle') {
          const branch = context.data.location.vcs.info(location())?.branch.current;
          locationWidth = cellWidth(abbreviateHome(directory(), home) + (branch ? `:${branch}` : ''));
        }
        return statuslineBudget({ rowWidth: rowWidth(), nativeWidth, locationWidth });
      });

      const visible = createMemo(() => fitSegments(segments(), budget()));

      return (
        <Show when={props.mode === 'normal' && props.showDetails}>
          <box position="absolute" left={0} right={0} height={0} onSizeChange={onRowSize} />
          <Show when={visible().length > 0}>
            <box flexShrink={1} minWidth={0}>
              <text wrapMode="none" truncate fg={theme.text.muted}>
                <For each={visible()}>
                  {(segment, index) => (
                    <>
                      <Show when={index() > 0}>{SEGMENT_SEPARATOR}</Show>
                      <span style={{ fg: toneColor(segment.tone) }}>{segment.text}</span>
                    </>
                  )}
                </For>
              </text>
            </box>
          </Show>
        </Show>
      );
    }

    cleanups.push(
      context.ui.slot({
        append: 'prompt.footer.status',
        render: (input) => <Statusline sessionID={input.sessionID} mode={input.mode} showDetails={input.showDetails} />,
      }),
    );

    return () => {
      for (const fn of cleanups.reverse()) fn();
    };
  },
});
