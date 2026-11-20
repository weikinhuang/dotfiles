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

## Delegation

- Delegate by default when the harness offers subagents. Keep the main thread for conversation, planning, design, and
  the high-level context of multi-phase work. Hand implementation, research, and other tool-heavy work to subagents so
  tool calls and file writes do not fill the main context.
- Pick the lightest model or agent that can do the task well: the smallest for searches, lookups, and mechanical edits;
  a mid tier for most implementation and research; the main model only for work that needs its full reasoning. If the
  harness does not let you choose a model, still delegate for the context savings.
- Give each subagent a self-contained brief: the goal, relevant context, constraints, and what "done" looks like. Ask it
  to report back with a concise summary of what it changed and anything it was unsure about.
- Review every subagent's result before treating the task as done. Check the summary against the brief and the overall
  plan, and spot-check the actual changes where the risk is high or the summary is vague. Do not re-read everything; the
  point is alignment, not redoing the work.
