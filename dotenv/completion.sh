# shellcheck shell=bash
# Configure shared shell completions and load per-command completion files.
# SPDX-License-Identifier: MIT

# Re-run completion against another command, using the current COMP_WORDS /
# COMP_CWORD / COMP_LINE / COMP_POINT.  The caller is expected to have rewritten
# those to look as if `cmd ARGS...` had been typed.
_dot_complete_delegate() {
  local cmd="$1"
  local cur="${COMP_WORDS[COMP_CWORD]:-}"
  local prev="${COMP_WORDS[COMP_CWORD-1]:-}"
  local spec
  spec="$(complete -p "${cmd}" 2>/dev/null)"
  if [[ -z "${spec}" ]]; then
    mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
    return
  fi
  if [[ "${spec}" =~ -F[[:space:]]+([^[:space:]]+) ]]; then
    "${BASH_REMATCH[1]}" "${cmd}" "${cur}" "${prev}"
  elif [[ "${spec}" =~ -W[[:space:]]+\"([^\"]*)\" ]] || [[ "${spec}" =~ -W[[:space:]]+\'([^\']*)\' ]]; then
    mapfile -t COMPREPLY < <(compgen -W "${BASH_REMATCH[1]}" -- "${cur}")
  else
    mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
  fi
}

# Completion handler for aliases.  Expands the alias body (via BASH_ALIASES,
# avoiding fragile parsing of `alias -p` output), rewrites COMP_WORDS as if the
# expansion had been typed, then delegates to the target command's completion.
_dot_complete_alias() {
  local alias_name="${COMP_WORDS[0]}"
  local body="${BASH_ALIASES[${alias_name}]:-}"
  [[ -z "${body}" ]] && return

  # Use eval so quoted segments inside the alias body parse correctly.
  # Body comes from BASH_ALIASES, which the user controls in their own shell.
  local -a body_tokens
  eval "body_tokens=(${body})" 2>/dev/null || return

  # Skip leading `VAR=value` env assignments to find the actual command.
  local idx=0
  while ((idx < ${#body_tokens[@]})) && [[ "${body_tokens[idx]}" == [A-Za-z_]*=* ]]; do
    ((idx++))
  done
  ((idx >= ${#body_tokens[@]})) && return
  local target="${body_tokens[idx]}"

  # Self-referential aliases like `alias sudo='sudo -S'` would recurse forever
  # if the target's registered completion is also _dot_complete_alias.  Bail to
  # plain file completion in that case.
  if [[ "${target}" == "${alias_name}" ]]; then
    mapfile -t COMPREPLY < <(compgen -f -- "${COMP_WORDS[COMP_CWORD]:-}")
    return
  fi

  COMP_WORDS=("${body_tokens[@]}" "${COMP_WORDS[@]:1}")
  COMP_CWORD=$((COMP_CWORD - 1 + ${#body_tokens[@]}))
  COMP_LINE="${COMP_WORDS[*]}"
  COMP_POINT=${#COMP_LINE}

  _dot_complete_delegate "${target}"
}

# Completion handler for `wrapper CMD [ARGS...]` (sudo, doas, time, ...).
# The first arg is completed as a command name; subsequent args are routed to
# CMD's own completion as if it had been typed directly.
_dot_complete_command_offset() {
  if ((COMP_CWORD <= 1)); then
    mapfile -t COMPREPLY < <(compgen -c -- "${COMP_WORDS[COMP_CWORD]:-}")
    return
  fi
  local target="${COMP_WORDS[1]}"
  COMP_WORDS=("${COMP_WORDS[@]:1}")
  COMP_CWORD=$((COMP_CWORD - 1))
  COMP_LINE="${COMP_WORDS[*]}"
  COMP_POINT=${#COMP_LINE}
  _dot_complete_delegate "${target}"
}

# sudo CMD ARGS... — route to CMD's completion (replaces plain `complete -cf`).
complete -F _dot_complete_command_offset sudo

# Source per-command completions for scripts in dotenv/bin/.
for __dot_completion_file in "${DOTFILES__ROOT}/.dotfiles/dotenv/completion"/*.bash; do
  [[ -f "${__dot_completion_file}" ]] || continue
  # shellcheck source=/dev/null
  source "${__dot_completion_file}"
done
unset __dot_completion_file

# Auto-register alias completion for every alias that doesn't already have a
# bespoke completion.  Run last so per-command and user completions take
# precedence.
__dot_register_alias_completions() {
  local alias_def alias_name
  while IFS= read -r alias_def; do
    alias_def="${alias_def#alias }"
    # `alias -p` prefixes alias names that look like options with `-- ` so
    # `alias -- -='cd -'` round-trips; strip it before extracting the name.
    alias_def="${alias_def#-- }"
    alias_name="${alias_def%%=*}"
    [[ -z "${alias_name}" ]] && continue
    # No `=` was found — not an alias definition we can parse.
    [[ "${alias_name}" == "${alias_def}" ]] && continue
    # The `complete` builtin can't register names starting with `-`.
    [[ "${alias_name}" == -* ]] && continue
    complete -p "${alias_name}" &>/dev/null && continue
    complete -F _dot_complete_alias "${alias_name}"
  done < <(alias -p 2>/dev/null)
}
__dot_register_alias_completions
unset -f __dot_register_alias_completions
