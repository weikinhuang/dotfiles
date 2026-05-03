# External Tooling

These are tools from external projects that are included in this repo for convenience. Prefer updating them from
upstream instead of editing the vendored copies directly.

## Vendored assets currently used

| Vendored file(s)                                                                                                                 | Upstream                                                                                                              | Used for                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`bash-preexec.sh`](./bash-preexec.sh)                                                                                           | [rcaloras/bash-preexec](https://github.com/rcaloras/bash-preexec)                                                     | Provides `preexec` and `precmd` hook support in interactive shells when `DOT_DISABLE_PREEXEC` is unset. Loaded from [`bashrc.sh`](../bashrc.sh).                                                                                                      |
| [`git-prompt.sh`](./git-prompt.sh)                                                                                               | [git/git `contrib/completion/git-prompt.sh`](https://github.com/git/git/blob/master/contrib/completion/git-prompt.sh) | Provides `__git_ps1` for the interactive prompt via [`plugins/30-git.sh`](../plugins/30-git.sh), and is also reused by [`config/claude/statusline-command.sh`](../config/claude/statusline-command.sh) so branch/status flags match the shell prompt. |
| [`dircolors.solarized.256dark`](./dircolors.solarized.256dark), [`dircolors.solarized.256light`](./dircolors.solarized.256light) | [seebi/dircolors-solarized](https://github.com/seebi/dircolors-solarized)                                             | Solarized `dircolors` themes used by [`plugins/10-dircolors.sh`](../plugins/10-dircolors.sh) when `DOT_SOLARIZED_DARK` or `DOT_SOLARIZED_LIGHT` is set.                                                                                               |

## Notes

- [`dircolors.solarized.ansi-light`](./dircolors.solarized.ansi-light) is vendored alongside the upstream theme set but
  is not currently referenced by the repo.
- See the [Solarized homepage](https://ethanschoonover.com/solarized/) for screenshots, details, and related theme
  ports.
