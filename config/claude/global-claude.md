# Global Claude Code Instructions

Linked as `~/.claude/CLAUDE.md`. The shared core applies to every harness; Claude-only rules go below the import.

@~/.dotfiles/config/agents/instructions.md

## Subagent usage

The shared Delegation rules above are standing permission to spawn subagents without asking first. Map the model tiers
to Haiku (smallest), Sonnet (mid), and the main model. Forks always inherit the main model, so use a non-fork agent with
an explicit `model` when cost matters.
