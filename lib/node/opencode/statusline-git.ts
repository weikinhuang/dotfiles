/**
 * Git decoration for the opencode `statusline` TUI plugin
 * (`config/opencode/plugins/statusline/`).
 *
 * opencode's native prompt footer already shows `<dir>:<branch>`, so the
 * plugin only adds what `__git_ps1` knows beyond the branch: dirty (`*`),
 * staged (`+`, or `#` before the first commit), stash (`$`), untracked
 * (`%`), upstream (`<`, `>`, `<>`, `=`), plus the sparse / rebase / merge
 * state. The vendored `external/git-prompt.sh` runs through
 * `lib/node/pi/git-prompt.ts` with a unit-separator state separator so the
 * branch can be split off reliably.
 *
 * Also owns the keyed, debounced refresher the plugin uses to re-run git on
 * events instead of polling.
 *
 * Pure module - no opencode imports.
 */

import { fetchGitSegmentAsync } from '../pi/git-prompt.ts';
import { resolveWorktreeInfo } from '../pi/git-worktree.ts';

/** `GIT_PS1_STATESEPARATOR` used to split the branch from the flags. */
export const GIT_STATE_SEPARATOR = '\x1f';

/** Parsed `__git_ps1 "%s"` output. */
export interface GitDecoration {
  /** Branch (or detached description), including any `BARE:` prefix. */
  branch: string;
  /** Working-tree flags in `__git_ps1` order, e.g. `*+$%=`; `''` when clean. */
  flags: string;
  /** Sparse / operation suffix, e.g. `|REBASE 1/2`, `|MERGING`; `''` when none. */
  state: string;
}

/** Flag characters `__git_ps1` emits after the state separator (`h w i s u p`). */
const FLAG_RUN = /^[?*+#$%<>=]+/;
/** Trailing sparse + operation state when no flags were emitted. */
const STATE_TAIL = /(?:\|SPARSE)?(?:\|[A-Z][A-Z-]*(?:\/[A-Z]+)?(?: \d+\/\d+)?)?(?:\|CONFLICT)?$/;
/** Trailing upstream indicator when no other flags were emitted. */
const UPSTREAM_TAIL = /(?:<>|<|>|=)$/;

/**
 * Parse the output of `__git_ps1 "%s"` run with
 * `GIT_PS1_STATESEPARATOR=` {@link GIT_STATE_SEPARATOR}. Returns `null` for
 * empty output (not a git repo, or bash failed).
 *
 * `__git_ps1` assembles `<c><b>[<sep><flags>]<sparse><r>`, where `flags`
 * includes the upstream indicator. Without the separator the flags are
 * empty, so only the operation state can trail the branch.
 */
export function parseGitPromptOutput(raw: string): GitDecoration | null {
  const text = raw.replace(/[\r\n]+/g, '').trim();
  if (!text) return null;
  const sep = text.indexOf(GIT_STATE_SEPARATOR);
  if (sep >= 0) {
    const rest = text.slice(sep + 1);
    const flags = FLAG_RUN.exec(rest)?.[0] ?? '';
    return { branch: text.slice(0, sep), flags, state: rest.slice(flags.length) };
  }
  const stateMatch = STATE_TAIL.exec(text)?.[0] ?? '';
  let head = text.slice(0, text.length - stateMatch.length);
  // Defensive: an upstream indicator without a separator only happens with a
  // custom `GIT_PS1_STATESEPARATOR=''`; keep it as a flag rather than branch text.
  const upstream = UPSTREAM_TAIL.exec(head)?.[0] ?? '';
  head = head.slice(0, head.length - upstream.length);
  return { branch: head, flags: upstream, state: stateMatch };
}

/**
 * Display text for the git segment: `(*+%=)`, `(|REBASE 1/2)`, or with
 * `withBranch` the full `(main *+%=)`. `''` when there is nothing beyond the
 * branch the native footer already shows.
 */
export function formatGitDecoration(decoration: GitDecoration | null, withBranch = false): string {
  if (!decoration) return '';
  const extra = `${decoration.flags}${decoration.state}`;
  if (withBranch) return decoration.branch || extra ? `(${[decoration.branch, extra].filter(Boolean).join(' ')})` : '';
  return extra ? `(${extra})` : '';
}

/** Git state for one directory, as rendered by the statusline. */
export interface GitSnapshot {
  decoration: GitDecoration | null;
  /** Linked-worktree name (`git worktree add <name>`), else `null`. */
  worktree: string | null;
}

/**
 * Read the decoration and worktree name for `cwd`. `scriptPath` `null` skips
 * `__git_ps1` (decoration stays `null`); the worktree lookup is pure fs.
 */
export async function readGitSnapshot(cwd: string, scriptPath: string | null): Promise<GitSnapshot> {
  let worktree: string | null = null;
  try {
    worktree = resolveWorktreeInfo(cwd)?.worktreeName ?? null;
  } catch {
    worktree = null;
  }
  if (!scriptPath) return { decoration: null, worktree };
  const raw = await fetchGitSegmentAsync({
    scriptPath,
    cwd,
    format: '%s',
    env: { GIT_PS1_STATESEPARATOR: GIT_STATE_SEPARATOR },
  });
  return { decoration: parseGitPromptOutput(raw), worktree };
}

/** Minimal timer surface so tests can drive the debounce deterministically. */
export interface RefresherTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface KeyedRefresherOptions<T> {
  fetch: (key: string) => Promise<T>;
  onValue: (key: string, value: T) => void;
  /** Coalesce `requestAll` bursts (tool calls, fs events) into one run. */
  debounceMs: number;
  timers?: RefresherTimers;
}

export interface KeyedRefresher {
  /** Start tracking `key`; fetches immediately the first time. */
  track(key: string): void;
  /** Debounced refetch of every tracked key. */
  requestAll(): void;
  /** Stop timers and drop late results. */
  dispose(): void;
}

const defaultTimers: RefresherTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Event-driven refresher keyed by directory. At most one fetch per key runs
 * at a time; a request that lands mid-fetch reruns once afterwards, so a
 * burst of events costs at most two runs. Fetch errors are swallowed (the
 * previous value stays).
 */
export function createKeyedRefresher<T>(options: KeyedRefresherOptions<T>): KeyedRefresher {
  const timers = options.timers ?? defaultTimers;
  const state = new Map<string, { inFlight: boolean; again: boolean }>();
  let timer: unknown;
  let disposed = false;

  const run = (key: string): void => {
    const entry = state.get(key);
    if (!entry || disposed) return;
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    entry.inFlight = true;
    entry.again = false;
    options
      .fetch(key)
      .then(
        (value) => {
          if (!disposed) options.onValue(key, value);
        },
        () => undefined,
      )
      .finally(() => {
        entry.inFlight = false;
        if (entry.again) run(key);
      });
  };

  return {
    track(key) {
      if (disposed || state.has(key)) return;
      state.set(key, { inFlight: false, again: false });
      run(key);
    },
    requestAll() {
      if (disposed) return;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = undefined;
        for (const key of state.keys()) run(key);
      }, options.debounceMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}
