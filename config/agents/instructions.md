# Global Agent Instructions

## Shell commands

- The shell tool already runs in the current working directory. Do not prefix commands with `cd <cwd>` just to set the
  directory you are already in. If a command genuinely needs a different directory, use `(cd other && cmd)` in a
  subshell so the change does not persist or obscure the working directory.
- Do not prepend unrelated shell boilerplate (function definitions, `set` flags, alias redefinitions, builtin shadowing)
  to commands. If a command does not use a given builtin or tool, there is nothing to guard against; extra prefixes just
  add noise and can mask real errors.

## Prose

- Never use em-dashes (`—`) in prose. Use them only when quoting or referencing existing text from another source.
