# External

Vendored third-party scripts and themes. These are copies of upstream sources, shipped in this repo for convenience so
the dotfiles work even when the host doesn't have the upstream package installed. See root [AGENTS.md](../AGENTS.md) for
repo-wide conventions; this file only documents what is different here.

## Commands

Vendored files are excluded from `./dev/lint.sh` by design - refresh them from upstream instead of editing in place.

- `curl -fsSL <upstream-url> -o external/<file>` - re-vendor one asset from its upstream URL. See
  [README.md](./README.md) for the canonical upstream URL per file.
- `diff -u external/<file> <(curl -fsSL <upstream-url>)` - preview the upstream diff before re-vendoring.

## Directory map

| Path                                                                                                                                                                                                   | Purpose                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`bash-preexec.sh`](./bash-preexec.sh)                                                                                                                                                                 | `preexec` / `precmd` hook support; loaded by [`../bashrc.sh`](../bashrc.sh).                 |
| [`git-prompt.sh`](./git-prompt.sh)                                                                                                                                                                     | `__git_ps1` for the interactive prompt and Claude Code statusline.                           |
| [`dircolors.solarized.256dark`](./dircolors.solarized.256dark), [`dircolors.solarized.256light`](./dircolors.solarized.256light), [`dircolors.solarized.ansi-light`](./dircolors.solarized.ansi-light) | Solarized `dircolors` themes.                                                                |
| [`README.md`](./README.md)                                                                                                                                                                             | Human-facing upstream-source table (upstream URL + which file / plugin consumes each asset). |

## Key patterns

- **Do not edit vendored files.** Re-vendor from upstream instead - any local edit will be overwritten on the next
  refresh and makes upstream diffs hard to review.
- **Hook consumers via `command -v`**, not by patching the vendored source. If the upstream file needs a tweak to work
  with this repo, wrap it from a plugin (e.g. [`../plugins/30-git.sh`](../plugins/30-git.sh) sources `git-prompt.sh`
  then sets `GIT_PS1_*` env vars around it).
- **One upstream, one file.** Keep each vendored asset in its original upstream layout; don't concatenate or rename
  files so `git log -- external/<file>` still maps cleanly to upstream commits.
- **Record every vendored asset in [README.md](./README.md)** - the "Vendored assets currently used" table is the source
  of truth for upstream URL + consumer.

## Boundaries

**Always**: update [README.md](./README.md) (the upstream-source table) when adding, removing, or retargeting a vendored
file; re-vendor by copying whole files from upstream; preserve upstream copyright / license headers verbatim.

**Ask first**: adding a new vendored dependency (licensing + long-term maintenance cost); removing one that shell
plugins or the statusline depend on (verify nothing sources it first).

**Never**: edit a vendored file in place to work around a bug - patch it from the consuming plugin or submit the fix
upstream; commit binary blobs; add non-vendored personal scripts to this directory (put those under
[`../dotenv/bin/`](../dotenv/bin/) or a plugin).

## References

- [README.md](./README.md) - upstream-source table with the canonical consumer for each file.
- [`../plugins/`](../plugins/) - shell plugins that source these vendored files (`30-git.sh`, `10-dircolors.sh`, …).
- [`../bashrc.sh`](../bashrc.sh) - loader that sources [`bash-preexec.sh`](./bash-preexec.sh) when `DOT_DISABLE_PREEXEC`
  is unset.
