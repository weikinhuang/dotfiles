#!/usr/bin/env bash
# @see https://code.claude.com/docs/en/statusline
# Claude Code status line — mirrors the dotfiles PS1 style:
#   [user#host cwd (git branch $%=) ctx% left Msg:↑input/↻ cached/↓output Session:input↑/output↓ cost] model
# SPDX-License-Identifier: MIT

# Colors matching the dotfiles PS1 palette (will be dimmed by Claude Code)
RESET='\e[0m'
GREY='\e[38;5;244m'
USER_COLOR='\e[38;5;197m'
HOST_COLOR='\e[38;5;208m'
DIR_COLOR='\e[38;5;142m'
GIT_COLOR='\e[38;5;135m'
WORKTREE_COLOR='\e[38;5;173m'
CONTEXT_COLOR='\e[38;5;035m'
TOKEN_COLOR='\e[38;5;245m'
AGENT_TOKEN_COLOR='\e[38;5;109m'
SESSION_TOKEN_COLOR='\e[38;5;179m'
TOOL_COLOR='\e[38;5;214m'
COST_COLOR='\e[38;5;108m'
RATE_LIMIT_COLOR='\e[38;5;111m'
RATE_LIMIT_WARN_COLOR='\e[38;5;203m'
RATE_LIMIT_NEAR_THRESHOLD=85
MODEL_COLOR='\e[38;5;033m'
BOLD='\e[1m'

print_ansi() {
  printf '%b' "$1"
}

print_colored_text() {
  local color="$1"
  local text="$2"
  printf '%b%s%b' "$color" "$text" "$RESET"
}

# shellcheck disable=SC1003
print_osc8_link() {
  local url="$1"
  local color="$2"
  local text="$3"
  printf '\e]8;;%s\e\\%b%s%b\e]8;;\e\\' "$url" "$color" "$text" "$RESET"
}

resolve_script_path() {
  local source_path="${BASH_SOURCE[0]}"
  local source_dir

  while [[ -L "${source_path}" ]]; do
    source_dir="$(cd -P "$(dirname "${source_path}")" && pwd)"
    source_path="$(readlink "${source_path}")"
    [[ "${source_path}" != /* ]] && source_path="${source_dir}/${source_path}"
  done

  printf '%s\n' "${source_path}"
}

load_git_prompt_helper() {
  local dotfiles_root="${DOTFILES_ROOT:-}"
  local script_path git_prompt_script

  if [[ -z "${dotfiles_root}" ]]; then
    script_path="$(resolve_script_path)"
    dotfiles_root="$(cd -P "$(dirname "${script_path}")/../.." && pwd)"
  fi

  git_prompt_script="${dotfiles_root}/external/git-prompt.sh"
  if [[ -r "${git_prompt_script}" ]]; then
    # shellcheck source=/dev/null
    source "${git_prompt_script}"
    HAS_GIT_PS1=1
  else
    HAS_GIT_PS1=
  fi
}

format_git_segment() {
  local cwd="$1"
  local git_segment branch_only

  [[ -n "${cwd}" ]] || return 0

  if [[ -n "${HAS_GIT_PS1:-}" ]]; then
    git_segment="$(
      cd "${cwd}" 2>/dev/null || exit 0
      GIT_PS1_SHOWDIRTYSTATE=true \
        GIT_PS1_SHOWSTASHSTATE=true \
        GIT_PS1_SHOWUNTRACKEDFILES=true \
        GIT_PS1_SHOWUPSTREAM=auto \
        __git_ps1 " (%s)"
    )"
    if [[ -n "${git_segment}" ]]; then
      printf '%s' "${git_segment}"
      return 0
    fi
  fi

  if git -C "${cwd}" rev-parse --is-inside-work-tree --no-optional-locks >/dev/null 2>&1; then
    branch_only="$(
      git -C "${cwd}" symbolic-ref --short HEAD 2>/dev/null \
        || git -C "${cwd}" rev-parse --short HEAD 2>/dev/null
    )"
    if [[ -n "${branch_only}" ]]; then
      printf ' (%s)' "${branch_only}"
    fi
  fi
}

HAS_GIT_PS1=
load_git_prompt_helper

# Format numbers with k/M suffixes for readability without external deps.
fmt_si() {
  local n="$1"
  local whole
  local fractional

  if ((n >= 1000000)); then
    whole=$((n / 1000000))
    fractional=$((((n % 1000000) * 100 + 500000) / 1000000))
    if ((fractional == 100)); then
      whole=$((whole + 1))
      fractional=0
    fi

    printf '%d.%02dM' "$whole" "$fractional"
  elif ((n >= 1000)); then
    printf '%dk' $((n / 1000))
  else
    printf '%d' "$n"
  fi
}

# Humanize a future epoch timestamp into a short "in N unit" form (e.g. 2h, 3d, 45m).
# Uses ${NOW_OVERRIDE} as the reference time when set, which keeps tests deterministic.
fmt_time_until() {
  local target="$1"
  local now delta

  now="${NOW_OVERRIDE:-$(date +%s)}"
  delta=$((target - now))
  ((delta < 0)) && delta=0

  if ((delta >= 86400)); then
    printf '%dd' $((delta / 86400))
  elif ((delta >= 3600)); then
    printf '%dh' $((delta / 3600))
  elif ((delta >= 60)); then
    printf '%dm' $((delta / 60))
  else
    printf '%ds' "${delta}"
  fi
}

sum_usage_from_files() {
  jq -s -r '
    [ .[] | select(type == "object" and .type == "assistant") ] as $assistants
    | [ .[] | select(type == "object" and .type == "user") ] as $users
    | [ $assistants[] | .message.usage // empty ] as $usages
    | [ $assistants[]
        | (.message.content // [])
        | map(select(.type == "tool_use")) | length ] as $tool_counts
    | [ $users[]
        | (.message.content // [])
        | if type == "array" then . else [] end
        | .[]
        | select(type == "object" and .type == "tool_result")
        | (.content // "")
        | if type == "string" then length
          elif type == "array" then
            (map(if type == "object" then ((.text // "") | length) else 0 end) | add // 0)
          else 0 end ] as $tool_bytes
    | [ ($usages | map((.input_tokens // 0) + (.cache_creation_input_tokens // 0)) | add // 0),
        ($usages | map(.cache_read_input_tokens // 0) | add // 0),
        ($usages | map(.output_tokens // 0) | add // 0),
        ($tool_counts | add // 0),
        ($tool_bytes | add // 0) ]
    | @tsv
  ' "$@" 2>/dev/null
}

sum_subagent_usage() {
  local transcript_path="$1"
  local subagent_dir files count totals

  [[ -n "${transcript_path}" ]] || return 0

  subagent_dir="${transcript_path%.jsonl}/subagents"
  [[ -d "${subagent_dir}" ]] || return 0

  # Collect only subagent assistant messages (.meta.json siblings are ignored).
  shopt -s nullglob
  files=("${subagent_dir}"/agent-*.jsonl)
  shopt -u nullglob
  count="${#files[@]}"
  ((count > 0)) || return 0

  totals=$(sum_usage_from_files "${files[@]}") || return 0
  printf '%s\t%s\n' "${count}" "${totals}"
}

sum_main_session_usage() {
  local transcript_path="$1"

  [[ -n "${transcript_path}" && -f "${transcript_path}" ]] || return 0

  sum_usage_from_files "${transcript_path}"
}

main() {
  local input
  local cwd model remaining input_tokens cached_tokens output_tokens
  local total_input_tokens total_output_tokens cost_usd transcript_path worktree_name
  local rate_five_pct rate_five_reset rate_seven_pct rate_seven_reset
  local agent_count agent_in agent_cached agent_out agent_tools agent_tool_bytes
  local session_in session_cached session_out session_tools session_tool_bytes
  local short_cwd git_branch worktree_part ctx_part cost_part token_part agent_token_part session_token_part tools_part
  local rate_five_part rate_five_color rate_seven_part rate_seven_color
  local in_fmt cached_fmt out_fmt total_in_fmt total_out_fmt
  local agent_in_fmt agent_cached_fmt agent_out_fmt
  local session_in_fmt session_cached_fmt session_out_fmt
  local user host

  input=$(cat)

  cwd=$(jq -r '.workspace.current_dir // .cwd // ""' <<<"${input}")
  model=$(jq -r '.model.display_name // ""' <<<"${input}")
  remaining=$(jq -r '.context_window.remaining_percentage // empty' <<<"${input}")
  # Fold cache_creation into the input arrow so cached-first turns show realistic input weight.
  input_tokens=$(jq -r '((.context_window.current_usage.input_tokens // 0) + (.context_window.current_usage.cache_creation_input_tokens // 0)) as $n | if .context_window.current_usage == null then empty else $n end' <<<"${input}")
  cached_tokens=$(jq -r '.context_window.current_usage.cache_read_input_tokens // empty' <<<"${input}")
  output_tokens=$(jq -r '.context_window.current_usage.output_tokens // empty' <<<"${input}")
  total_input_tokens=$(jq -r '.context_window.total_input_tokens // empty' <<<"${input}")
  total_output_tokens=$(jq -r '.context_window.total_output_tokens // empty' <<<"${input}")
  cost_usd=$(jq -r '.cost.total_cost_usd // empty' <<<"${input}")
  transcript_path=$(jq -r '.transcript_path // empty' <<<"${input}")
  # Prefer workspace.git_worktree since it covers any linked worktree, not just --worktree sessions.
  worktree_name=$(jq -r '.workspace.git_worktree // .worktree.name // empty' <<<"${input}")
  rate_five_pct=$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"${input}")
  rate_five_reset=$(jq -r '.rate_limits.five_hour.resets_at // empty' <<<"${input}")
  rate_seven_pct=$(jq -r '.rate_limits.seven_day.used_percentage // empty' <<<"${input}")
  rate_seven_reset=$(jq -r '.rate_limits.seven_day.resets_at // empty' <<<"${input}")

  # Just the directory name, not the full path.
  short_cwd="${cwd##*/}"

  # Reuse git-prompt.sh so branch flags match the interactive PS1 prompt.
  git_branch="$(format_git_segment "${cwd}")"

  worktree_part=""
  if [[ -n "${worktree_name}" ]]; then
    worktree_part=" ⎇ ${worktree_name}"
  fi

  # Context remaining.
  ctx_part=""
  if [[ -n "${remaining}" ]]; then
    ctx_part=" ${remaining}% left"
  fi

  # Cost.
  cost_part=""
  if [[ -n "${cost_usd}" ]]; then
    cost_part=$(printf ' $%.3f' "${cost_usd}")
  fi

  # Rate limits (Pro/Max subscribers only; each window may be independently absent).
  # Each half is formatted as " 5h:NN%·<countdown>" and independently color-flipped
  # to warn red when usage reaches RATE_LIMIT_NEAR_THRESHOLD.
  local rate_pct_int
  rate_five_part=""
  rate_five_color="${RATE_LIMIT_COLOR}"
  if [[ -n "${rate_five_pct}" ]]; then
    rate_pct_int=$(printf '%.0f' "${rate_five_pct}")
    rate_five_part=" 5h:${rate_pct_int}%"
    if [[ -n "${rate_five_reset}" ]]; then
      rate_five_part="${rate_five_part}·$(fmt_time_until "${rate_five_reset}")"
    fi
    ((rate_pct_int >= RATE_LIMIT_NEAR_THRESHOLD)) && rate_five_color="${RATE_LIMIT_WARN_COLOR}"
  fi
  rate_seven_part=""
  rate_seven_color="${RATE_LIMIT_COLOR}"
  if [[ -n "${rate_seven_pct}" ]]; then
    rate_pct_int=$(printf '%.0f' "${rate_seven_pct}")
    rate_seven_part=" 7d:${rate_pct_int}%"
    if [[ -n "${rate_seven_reset}" ]]; then
      rate_seven_part="${rate_seven_part}·$(fmt_time_until "${rate_seven_reset}")"
    fi
    ((rate_pct_int >= RATE_LIMIT_NEAR_THRESHOLD)) && rate_seven_color="${RATE_LIMIT_WARN_COLOR}"
  fi

  # Token counts from the last API call.
  token_part=""
  if [[ -n "${input_tokens}" ]]; then
    in_fmt=$(fmt_si "${input_tokens}")
    cached_fmt=$(fmt_si "${cached_tokens:-0}")
    out_fmt=$(fmt_si "${output_tokens:-0}")
    token_part=" M:↑${in_fmt}/↻ ${cached_fmt}/↓${out_fmt}"
  fi

  # Cumulative subagent token totals, excluding main-agent usage.
  agent_token_part=""
  if [[ -n "${transcript_path}" ]]; then
    IFS=$'\t' read -r agent_count agent_in agent_cached agent_out agent_tools agent_tool_bytes < <(sum_subagent_usage "${transcript_path}") || true
    if [[ -n "${agent_count:-}" ]] && ((agent_count > 0)); then
      agent_in_fmt=$(fmt_si "${agent_in:-0}")
      agent_cached_fmt=$(fmt_si "${agent_cached:-0}")
      agent_out_fmt=$(fmt_si "${agent_out:-0}")
      agent_token_part=" A(${agent_count}):↑${agent_in_fmt}/↻ ${agent_cached_fmt}/↓${agent_out_fmt}"
    fi
  fi

  # Cumulative session token totals. Prefer transcript-derived numbers so we can
  # surface cache read alongside input/output; fall back to JSON totals otherwise.
  session_token_part=""
  if [[ -n "${transcript_path}" ]]; then
    IFS=$'\t' read -r session_in session_cached session_out session_tools session_tool_bytes < <(sum_main_session_usage "${transcript_path}") || true
    if [[ -n "${session_in:-}" ]] && ((session_in + session_cached + session_out > 0)); then
      session_in_fmt=$(fmt_si "${session_in}")
      session_cached_fmt=$(fmt_si "${session_cached}")
      session_out_fmt=$(fmt_si "${session_out}")
      session_token_part=" S:${session_in_fmt}↑/${session_cached_fmt}↻/${session_out_fmt}↓"
    fi
  fi
  if [[ -z "${session_token_part}" && -n "${total_input_tokens}" ]]; then
    total_in_fmt=$(fmt_si "${total_input_tokens}")
    total_out_fmt=$(fmt_si "${total_output_tokens:-0}")
    session_token_part=" S:${total_in_fmt}↑/${total_out_fmt}↓"
  fi

  # Tool call counters with an estimated tool_result token cost in parens
  # (bytes/4 is a rough proxy; ~ signals estimation).
  tools_part=""
  local tools_inner=""
  if [[ -n "${agent_tools:-}" ]] && ((agent_tools > 0)); then
    tools_inner=" A:${agent_tools}"
    if [[ -n "${agent_tool_bytes:-}" ]] && ((agent_tool_bytes > 0)); then
      tools_inner="${tools_inner}(~$(fmt_si $((agent_tool_bytes / 4))))"
    fi
  fi
  if [[ -n "${session_tools:-}" ]] && ((session_tools > 0)); then
    tools_inner="${tools_inner} S:${session_tools}"
    if [[ -n "${session_tool_bytes:-}" ]] && ((session_tool_bytes > 0)); then
      tools_inner="${tools_inner}(~$(fmt_si $((session_tool_bytes / 4))))"
    fi
  fi
  if [[ -n "${tools_inner}" ]]; then
    tools_part=" ⚒${tools_inner}"
  fi

  local cwd_url=""
  if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]] && [[ -n "${cwd}" ]]; then
    if [[ -n "${WSL_DISTRO_NAME:-}" ]] && [[ "${cwd}" == /mnt/[a-z]/* ]]; then
      local drive="${cwd:5:1}"
      cwd_url="file:///${drive^}:${cwd:6}"
    elif [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
      cwd_url="file://wsl.localhost/${WSL_DISTRO_NAME}${cwd}"
    elif [[ -z "${SSH_CLIENT:-}" ]]; then
      cwd_url="file://${cwd}"
    fi
  fi

  user=$(whoami)
  host=$(hostname -s)

  print_ansi "${BOLD}${GREY}[${RESET}"
  print_colored_text "${USER_COLOR}" "${user}"
  print_ansi "${GREY}#${RESET}"
  print_colored_text "${HOST_COLOR}" "${host}"
  printf ' '
  if [[ -n "${cwd_url}" ]]; then
    print_osc8_link "${cwd_url}" "${DIR_COLOR}" "${short_cwd}"
  else
    print_colored_text "${DIR_COLOR}" "${short_cwd}"
  fi
  print_colored_text "${GIT_COLOR}" "${git_branch}"
  print_colored_text "${WORKTREE_COLOR}" "${worktree_part}"
  print_colored_text "${CONTEXT_COLOR}" "${ctx_part}"
  if [[ -n "${cost_part}" ]] && [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]]; then
    printf ' '
    print_osc8_link "https://claude.ai/settings/usage" "${COST_COLOR}" "${cost_part# }"
  else
    print_colored_text "${COST_COLOR}" "${cost_part}"
  fi
  print_colored_text "${rate_five_color}" "${rate_five_part}"
  print_colored_text "${rate_seven_color}" "${rate_seven_part}"
  print_ansi "${BOLD}${GREY}]${RESET} "
  print_colored_text "${MODEL_COLOR}" "${model}"
  # Second line: per-turn, subagent, session token totals, and tool call counts. ↳ ties it to line 1.
  if [[ -n "${token_part}${agent_token_part}${session_token_part}${tools_part}" ]]; then
    printf '\n'
    print_colored_text "${GREY}" " ↳"
    local need_sep=""
    if [[ -n "${token_part}" ]]; then
      print_colored_text "${TOKEN_COLOR}" "${token_part}"
      need_sep=1
    fi
    if [[ -n "${agent_token_part}" ]]; then
      [[ -n "${need_sep}" ]] && print_colored_text "${GREY}" " |"
      print_colored_text "${AGENT_TOKEN_COLOR}" "${agent_token_part}"
      need_sep=1
    fi
    if [[ -n "${session_token_part}" ]]; then
      [[ -n "${need_sep}" ]] && print_colored_text "${GREY}" " |"
      print_colored_text "${SESSION_TOKEN_COLOR}" "${session_token_part}"
      need_sep=1
    fi
    if [[ -n "${tools_part}" ]]; then
      [[ -n "${need_sep}" ]] && print_colored_text "${GREY}" " |"
      print_colored_text "${TOOL_COLOR}" "${tools_part}"
    fi
  fi
  printf '\n'
}

main "$@"
