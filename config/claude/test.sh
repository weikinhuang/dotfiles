#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cwd="${1:-$PWD}"
branch="$(git -C "${cwd}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

jq -n \
  --arg cwd "${cwd}" \
  --arg branch "${branch}" \
  '{
    cwd: $cwd,
    session_id: "abc123...",
    transcript_path: "/path/to/transcript.jsonl",
    model: {
      id: "claude-opus-4-6",
      display_name: "Opus"
    },
    workspace: {
      current_dir: $cwd,
      project_dir: $cwd
    },
    version: "1.0.80",
    output_style: {
      name: "default"
    },
    cost: {
      total_cost_usd: 0.01234,
      total_duration_ms: 45000,
      total_api_duration_ms: 2300,
      total_lines_added: 156,
      total_lines_removed: 23
    },
    context_window: {
      total_input_tokens: 15234567,
      total_output_tokens: 4521,
      context_window_size: 200000,
      used_percentage: 8,
      remaining_percentage: 92,
      current_usage: {
        input_tokens: 8500,
        output_tokens: 1200,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 2000
      }
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: {
        used_percentage: 23.5,
        resets_at: 1738425600
      },
      seven_day: {
        used_percentage: 41.2,
        resets_at: 1738857600
      }
    },
    vim: {
      mode: "NORMAL"
    },
    agent: {
      name: "security-reviewer"
    },
    worktree: {
      name: "my-feature",
      path: "/path/to/.claude/worktrees/my-feature",
      branch: $branch,
      original_cwd: $cwd,
      original_branch: $branch
    }
  }' | bash "${script_dir}/statusline-command.sh"
