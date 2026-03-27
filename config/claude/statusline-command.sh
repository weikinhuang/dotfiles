#!/usr/bin/env bash
# Claude Code status line — mirrors the dotfiles PS1 style:
#   [user#host cwd<git>] model context%

# Colors matching the dotfiles PS1 palette (will be dimmed by Claude Code)
RESET='\e[0m'
GREY='\e[38;5;244m'
USER_COLOR='\e[38;5;197m'
HOST_COLOR='\e[38;5;208m'
DIR_COLOR='\e[38;5;142m'
GIT_COLOR='\e[38;5;135m'
CONTEXT_COLOR='\e[38;5;035m'
TOKEN_COLOR='\e[38;5;245m'
SESSION_TOKEN_COLOR='\e[38;5;179m'
COST_COLOR='\e[38;5;108m'
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

main() {
  local input
  local cwd model remaining input_tokens cached_tokens output_tokens
  local total_input_tokens total_output_tokens cost_usd
  local short_cwd git_branch ctx_part cost_part token_part session_token_part
  local in_fmt cached_fmt out_fmt total_in_fmt total_out_fmt
  local user host

  input=$(cat)

  cwd=$(jq -r '.workspace.current_dir // .cwd // ""' <<<"${input}")
  model=$(jq -r '.model.display_name // ""' <<<"${input}")
  remaining=$(jq -r '.context_window.remaining_percentage // empty' <<<"${input}")
  input_tokens=$(jq -r '.context_window.current_usage.input_tokens // empty' <<<"${input}")
  cached_tokens=$(jq -r '.context_window.current_usage.cache_read_input_tokens // empty' <<<"${input}")
  output_tokens=$(jq -r '.context_window.current_usage.output_tokens // empty' <<<"${input}")
  total_input_tokens=$(jq -r '.context_window.total_input_tokens // empty' <<<"${input}")
  total_output_tokens=$(jq -r '.context_window.total_output_tokens // empty' <<<"${input}")
  cost_usd=$(jq -r '.cost.total_cost_usd // empty' <<<"${input}")

  # Just the directory name, not the full path.
  short_cwd="${cwd##*/}"

  # Git branch (skip optional locks to avoid contention).
  git_branch=""
  if [[ -n "${cwd}" ]] && git -C "${cwd}" rev-parse --is-inside-work-tree --no-optional-locks >/dev/null 2>&1; then
    git_branch=$(git -C "${cwd}" symbolic-ref --short HEAD 2>/dev/null \
      || git -C "${cwd}" rev-parse --short HEAD 2>/dev/null)
    if [[ -n "${git_branch}" ]]; then
      git_branch=" (${git_branch})"
    fi
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

  # Token counts from the last API call.
  token_part=""
  if [[ -n "${input_tokens}" ]]; then
    in_fmt=$(fmt_si "${input_tokens}")
    cached_fmt=$(fmt_si "${cached_tokens:-0}")
    out_fmt=$(fmt_si "${output_tokens:-0}")
    token_part=" M:↑${in_fmt}/↻ ${cached_fmt}/↓${out_fmt}"
  fi

  # Cumulative session token totals.
  session_token_part=""
  if [[ -n "${total_input_tokens}" ]]; then
    total_in_fmt=$(fmt_si "${total_input_tokens}")
    total_out_fmt=$(fmt_si "${total_output_tokens:-0}")
    session_token_part=" S:${total_in_fmt}↑/${total_out_fmt}↓"
  fi

  user=$(whoami)
  host=$(hostname -s)

  print_ansi "${BOLD}${GREY}[${RESET}"
  print_colored_text "${USER_COLOR}" "${user}"
  print_ansi "${GREY}#${RESET}"
  print_colored_text "${HOST_COLOR}" "${host}"
  printf ' '
  print_colored_text "${DIR_COLOR}" "${short_cwd}"
  print_colored_text "${GIT_COLOR}" "${git_branch}"
  print_colored_text "${CONTEXT_COLOR}" "${ctx_part}"
  print_colored_text "${TOKEN_COLOR}" "${token_part}"
  print_colored_text "${SESSION_TOKEN_COLOR}" "${session_token_part}"
  print_colored_text "${COST_COLOR}" "${cost_part}"
  print_ansi "${BOLD}${GREY}]${RESET} "
  print_colored_text "${MODEL_COLOR}" "${model}"
  printf '\n'
}

main "$@"
