# `statusline`

Extra prompt-footer segments for opencode, ported from the pi [`statusline`](../../../pi/extensions/statusline.md)
extension. It adds to opencode's native footer instead of replacing it, and shows only what the native footer and prompt
metadata row lack. TUI part only: [`tui.tsx`](./tui.tsx), with the logic in
[`lib/node/opencode/statusline.ts`](../../../../lib/node/opencode/statusline.ts) and
[`lib/node/opencode/statusline-git.ts`](../../../../lib/node/opencode/statusline-git.ts).

## Example

A session at 120 columns with staged and dirty files, then at 70 columns:

```text
  /private/tmp/opencode-smoke-sl:main       (+) · R 100% · W 117 · ⚒ 2 · §AaGkOmp8  8.9K (1%) · $0.00  ctrl+p commands
  /…/opencode-smoke-sl:main    (+) · R 100% · ⚒ 2  8.9K (1%) · $0.00
```

The location label on the left and the usage, cost, and shortcut on the right are native; the middle is this plugin.
While a turn runs, the native spinner replaces the label and the segments keep updating.

## What the native UI already shows

The plugin skips these so nothing is duplicated:

- **Prompt metadata row:** agent (the pi persona analog), model, provider, and model variant (the thinking-level
  analog).
- **Footer:** `<dir>:<branch>` while idle, the spinner and `esc interrupt` while running, running subagents and shells,
  context tokens with the percent of the model's limit, session cost (including subagents), and the shortcuts.

## Segments

Placed in the `prompt.footer.status` slot, after the native location label. Segments render in this order and drop from
the end of the priority list when the row is too narrow:

| Id         | Example         | Priority | Content                                                                                  |
| ---------- | --------------- | -------- | ---------------------------------------------------------------------------------------- |
| `git`      | `(*+$%=)`       | 1        | `__git_ps1` flags beyond the branch: dirty, staged, stash, untracked, upstream, rebase.  |
| `worktree` | `⎇ feature-x`   | 2        | Linked-worktree name (`git worktree add`), read from `.git` metadata.                    |
| `cache`    | `R 92%/88%`     | 3        | Prompt-cache hit ratio, last step / session; `cache.read / (input + cache.read)`.        |
| `tools`    | `⚒ 6`           | 4        | Tool calls in the session.                                                               |
| `write`    | `W 1k`          | 5        | Session cache-write tokens, shown when non-zero.                                         |
| `tokens`   | `↑1k/↻ 9k/↓180` | 6        | Opt-in: last step's input / cache-read / output tokens.                                  |
| `id`       | `§AaGkOmp8`     | 7        | Last 8 characters of the session id (the head is a timestamp shared by nearby sessions). |
| `user`     | `me#host`       | 8        | `user#host` of the machine running the TUI.                                              |

The cache ratio collapses to `R 92%` when the last step and the session agree. It is green at 50% and above, amber
below. On the home screen only `git`, `worktree`, and `user` can appear.

The width budget is the footer row's measured width minus a mirror of the native footer's own layout decision and up to
24 cells for the location label. When the native footer shows extra items (running subagents or shells, a goal), the
text truncates instead.

## Git refresh

The git segment runs the vendored [`external/git-prompt.sh`](../../../../external/git-prompt.sh) with the same
`GIT_PS1_*` flags as the shell prompt, once per directory on mount, then again (debounced 400 ms) on:

- `vcs.branch.updated` and `filesystem.changed` (opencode watches `.git/HEAD`),
- tool calls finishing, `!` shell commands ending, and turns ending,
- terminal focus (needs focus reporting, for example `set -g focus-events on` in tmux),
- an optional interval (`gitInterval`).

Edits made outside opencode while the terminal keeps focus show up at the next event. There is no polling by default.

## Options

TUI parts do not receive `opencode.jsonc` options in opencode 2.2.7, so configure through the environment, for example
in `<config dir>/env` (see [Profiles](../../README.md#profiles)).

| Env                                | Default | Effect                                                                               |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `OPENCODE_STATUSLINE_ENABLED`      | `true`  | `false` disables the plugin.                                                         |
| `OPENCODE_STATUSLINE_SEGMENTS`     | unset   | Segment ids, e.g. `git,cache,id`; `+tokens,-user` edits the default; `all` / `none`. |
| `OPENCODE_STATUSLINE_GIT_PROMPT`   | `true`  | `false` skips `__git_ps1` (the `git` segment then never shows).                      |
| `OPENCODE_STATUSLINE_GIT_BRANCH`   | `false` | Repeat the branch inside the git segment: `(main *+%)`.                              |
| `OPENCODE_STATUSLINE_GIT_INTERVAL` | `0`     | Extra periodic git refresh in seconds; `0` keeps it event-driven.                    |
| `DOTFILES_ROOT`                    | unset   | Where to look for `external/git-prompt.sh`; defaults to walking up from `tui.tsx`.   |

The default segment list is every id except `tokens`. Booleans accept `true` / `false` or the dotenv `1` / `0`, `yes` /
`no`, `on` / `off` words.

## Limitations

- Git runs in the TUI process against the session directory. With `--server` against a remote host, the directory may
  not exist locally and the git segments stay empty; `user#host` names the client machine.
- Counts and ratios cover the current session only; subagent sessions are not summed (native cost is).
- The native-footer mirror follows opencode 2.2.7's `promptFooterLayout`; a later layout change can make the budget
  drift, which degrades to truncation.
- opencode watches only the plugin entry file; restart opencode after editing the `lib/node/` helpers.

## Live test

```bash
./dev/opencode-plugin-smoke.sh start -n sl statusline
D="$(./dev/opencode-plugin-smoke.sh dir sl)"
(cd "$D" && printf '.opencode/\nbin/\n' >.gitignore && git add .gitignore && git commit -qm init \
  && echo x >a.txt && git add a.txt && echo y >b.txt)
./dev/opencode-plugin-smoke.sh send sl 'Use your bash tool to run: ls -a . Then reply with exactly: READY'
./dev/opencode-plugin-smoke.sh wait sl '^ +READY'
./dev/opencode-plugin-smoke.sh capture sl 2
tmux resize-window -t sl -x 70 && ./dev/opencode-plugin-smoke.sh capture sl 1
./dev/opencode-plugin-smoke.sh stop sl
```
