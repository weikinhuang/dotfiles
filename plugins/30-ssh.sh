# shellcheck shell=bash
# Configure SSH agent and completion helpers.
# SPDX-License-Identifier: MIT

if ! command -v ssh &>/dev/null; then
  return
fi

# setup ssh agent automatically
# https://help.github.com/en/github/authenticating-to-github/working-with-ssh-key-passphrases#auto-launching-ssh-agent-on-msysgit
# https://stackoverflow.com/questions/18880024/start-ssh-agent-on-login
function internal::ssh-agent-start() {
  local ssh_agent_env agent_run_state

  ssh_agent_env="${HOME}/.ssh/agent.env"

  if [[ ! -d "${HOME}/.ssh" ]]; then
    mkdir -m 0700 "${HOME}/.ssh" || return
  fi

  if [[ -f "${ssh_agent_env}" ]]; then
    # shellcheck source=/dev/null
    source "${ssh_agent_env}" >|/dev/null
  fi

  # agent_run_state: 0=agent running w/ key; 1=agent w/o key; 2= agent not running
  agent_run_state=$(
    ssh-add -l >|/dev/null 2>&1
    echo $?
  )

  if [ ! "${SSH_AUTH_SOCK}" ] || [ "${agent_run_state}" = 2 ]; then
    (
      umask 077
      ssh-agent >|"${ssh_agent_env}"
    )
    # shellcheck source=/dev/null
    . "${ssh_agent_env}" >|/dev/null
    ssh-add
  elif [ "${SSH_AUTH_SOCK}" ] && [ "${agent_run_state}" = 1 ]; then
    ssh-add
  fi
}

# only start the agent if we don't already have a SSH_AUTH_SOCK
if [[ -n "${DOT_AUTOLOAD_SSH_AGENT:-}" ]] && { [[ -z "${SSH_AUTH_SOCK:-}" ]] || [[ ! -e "${SSH_AUTH_SOCK:-}" ]]; } && command -v ssh-agent &>/dev/null; then
  internal::ssh-agent-start
  unset DOT_AUTOLOAD_SSH_AGENT
fi
unset -f internal::ssh-agent-start

function internal::ssh-completion-needs-refresh() {
  local cache_file="$1"
  local src

  [[ ! -f "${cache_file}" ]] && return 0

  for src in "${HOME}/.ssh/config" "${HOME}/.ssh/known_hosts" "${HOME}"/.ssh/config.d/*; do
    [[ -e "${src}" ]] || continue
    if [[ "${src}" -nt "${cache_file}" ]]; then
      return 0
    fi
  done
  return 1
}

function internal::ssh-completion-refresh-cache() {
  internal::cache-write-atomic "$1" "internal::ssh-completion-generate-cache"
}

# shellcheck disable=SC2329  # Invoked indirectly via internal::cache-write-atomic.
function internal::ssh-completion-generate-cache() {
  local line host
  local -a ssh_hosts=()

  while IFS= read -r line; do
    [[ "${line}" == Host\ * ]] || continue
    [[ "${line}" == *no-complete* ]] && continue
    set -f
    for host in ${line#Host }; do
      [[ "${host}" == *['?*']* ]] || ssh_hosts+=("${host}")
    done
    set +f
  done < <(cat "${HOME}/.ssh/config" "${HOME}"/.ssh/config.d/* 2>/dev/null)

  if [[ -e "${HOME}/.ssh/known_hosts" ]]; then
    while IFS=', ' read -r host _; do
      host="${host%%]*}"
      host="${host#\[}"
      host="${host%%:*}"
      [[ "${host}" == *\|* ]] || ssh_hosts+=("${host}")
    done <"${HOME}/.ssh/known_hosts"
  fi

  if [[ ${#ssh_hosts[@]} -gt 0 ]]; then
    printf '%s\n' "${ssh_hosts[@]}" | sort -u
  fi
}

function internal::ssh-configure-completion() {
  local cache_file host_words

  cache_file="${DOTFILES__CONFIG_DIR}/cache/completions/ssh_hosts.list"
  if internal::ssh-completion-needs-refresh "${cache_file}"; then
    internal::ssh-completion-refresh-cache "${cache_file}"
  fi
  if [[ -s "${cache_file}" ]]; then
    host_words="$(tr '\n' ' ' <"${cache_file}")"
    complete -o default -W "${host_words}" ssh
  fi
}

# SSH auto-completion based on entries in known_hosts and config.
if command -v complete &>/dev/null && ! complete -p ssh &>/dev/null; then
  internal::ssh-configure-completion
fi

unset -f internal::ssh-completion-needs-refresh
unset -f internal::ssh-completion-refresh-cache
unset -f internal::ssh-completion-generate-cache
unset -f internal::ssh-configure-completion
