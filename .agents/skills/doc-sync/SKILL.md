---
name: doc-sync
description:
  'WHAT: Keep REFERENCE.md and the README.md Configuration Options table in lockstep with the public shell surface of
  this dotfiles repo. WHEN: User adds, renames, or removes an alias, shell function, environment variable, git
  subcommand, hook, prompt option, plugin-exposed behavior, command on PATH, or a DOT_ / BASHRC_ startup variable.
  DO-NOT: Update only one of REFERENCE.md and README.md when both apply; do not touch either file for purely internal
  helpers, refactors, or non-user-facing changes.'
---

# Doc sync for the public shell surface

`REFERENCE.md` is the single source of truth for everything a user can type at a shell after sourcing this repo:
aliases, functions, env vars, git subcommands, hooks, prompt options, plugin-exposed behavior, and commands on `$PATH`.
The Configuration Options table in `README.md` duplicates the user-facing `DOT_*` and `BASHRC_*` startup variables. Both
can drift silently, so any change to that surface needs a matching doc edit in the same commit.

## When to use this skill

Apply this skill when a code change adds, renames, or removes any of:

- A shell alias under `dotenv/aliases` or a platform-scoped aliases file.
- A shell function exposed for user invocation (not internal `__dot_*` / `internal::*` helpers).
- A git subcommand (`dotenv/bin/git-*` or any other `bin/git-*`).
- An executable on `$PATH` under `dotenv/bin/` or a platform `bin/` directory.
- A user-facing environment variable read by the shell.
- A startup configuration variable (`DOT_*`, `BASHRC_*`).
- A hook surface (`chpwd`, `precmd`, `preexec`, or `dotfiles_hook_*`).
- A prompt option, prompt segment, or plugin-exposed behavior.

Skip this skill when the change is internal: refactoring an implementation, renaming a private helper, moving code
between files without changing the user-callable surface, or editing tests.

## What lives where

`REFERENCE.md` sections (one or more may apply per change):

- `## Core shell interface` - aliases and user-facing functions.
- `## Built-in plugin interface` - plugin-exposed behavior and `DOT_PLUGIN_DISABLE_*` toggles.
- `## Commands on PATH > ### Utility commands` - non-git executables under any `bin/` directory.
- `## Commands on PATH > ### Git subcommands` - `git-*` scripts invoked as `git <name>`. NOTE: `## Git aliases` is for
  git-config aliases like `gco` / `gst`, not for `git-*` scripts.
- `## Hooks and extension points` - `chpwd` / `precmd` / `preexec`, per-phase hooks, `~/.bash_local` knobs.
- `## Environment variables` has multiple subsections; pick by what the variable does:
  - `### Runtime exports` - non-startup env vars exported at load.
  - `### Startup configuration variables` - non-prompt `DOT_*` / `BASHRC_*` knobs read once during init.
  - `### Prompt configuration variables > #### Prompt options` - prompt-specific `DOT_*` knobs (`DOT_DISABLE_PS1`,
    `DOT_GIT_PROMPT_*`, `DOT_PS1_*`, etc.). A new prompt knob goes here, not under Startup configuration variables.
  - `### Prompt configuration variables > #### Prompt segment helpers`, `#### Prompt symbol overrides`,
    `#### Prompt color overrides` - pick the most specific subsection.
- `## Additional tools` - vendored CLIs, completions, integrations.

`README.md` Configuration Options table:

- The table under `## Configuration Options` is a single flat alphabetical list of every `DOT_*` and `BASHRC_*`
  user-facing startup variable, regardless of whether `REFERENCE.md` splits it across
  `### Startup configuration variables` and `#### Prompt options`. Add the entry exactly once.
- Defaults and one-line descriptions should match the corresponding `REFERENCE.md` row in shape; `README.md` writes
  `UNSET` in uppercase where `REFERENCE.md` uses lowercase `unset`. That casing difference is intentional; do not
  normalize it.

## Workflow

1. Identify the change type and the user-facing surface it touches. If the change is purely internal, stop; this skill
   does not apply.
2. Locate the matching section(s) in `REFERENCE.md`. Most surfaces are tabular; keep the existing column layout and
   alphabetical or logical order.
3. For added entries: insert the row in the right place, link the source path with a relative link where the section
   convention does so, and write a one-line description in the same voice as neighboring rows.
4. For renames: update both the entry and any cross-references. Search `REFERENCE.md` for the old name to catch links,
   examples, and "see also" lines.
5. For removals: drop the row and check that no other entry references it.
6. If the change is a `DOT_*` or `BASHRC_*` variable, repeat the same insert/rename/remove edit in the `README.md`
   Configuration Options table. Defaults and one-line descriptions should match `REFERENCE.md` exactly.
7. Stage `REFERENCE.md` (and `README.md` when applicable) in the same commit as the code change.

## Verification

- `grep` for the old name across the repo after a rename to catch stale references in docs, tests, and other markdown.
- For startup variables, diff the names between the two tables to confirm they match. A simple check:

```sh
diff <(grep -oE '`(DOT|BASHRC)_[A-Z0-9_]+`' README.md | sort -u) \
     <(grep -oE '`(DOT|BASHRC)_[A-Z0-9_]+`' REFERENCE.md | sort -u)
```

- Run `./dev/lint.sh` if shell scripts changed; markdown is checked by `lint-staged` on commit.

## Common pitfalls

- Editing only `REFERENCE.md` for a new `DOT_*` knob and forgetting the `README.md` table.
- Putting a `git-*` script in `## Git aliases`. That section is for git-config aliases (`gco`, `gst`, etc.). Scripts
  named `git-<name>` belong under `## Commands on PATH > ### Git subcommands`.
- Putting a prompt-related `DOT_*` knob in `### Startup configuration variables`. Prompt knobs go in
  `### Prompt configuration variables > #### Prompt options`. Adding to both subsections duplicates the entry; pick the
  more specific one.
- Renaming a `git-*` subcommand and missing the link inside the `### Git subcommands` table that points at the old file
  path.
- Adding a one-line description that restates the name. Match the density of neighboring rows; descriptions should add
  information, not paraphrase the identifier.
- Documenting an `__dot_*` or `internal::*` helper. Internal names do not belong in `REFERENCE.md`.
