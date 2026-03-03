# shellcheck shell=bash

if ! command -v ssh &>/dev/null; then
  return
fi

# setup ssh agent automatically
# https://help.github.com/en/github/authenticating-to-github/working-with-ssh-key-passphrases#auto-launching-ssh-agent-on-msysgit
# https://stackoverflow.com/questions/18880024/start-ssh-agent-on-login
function _ssh-agent-start() {
  local SSH_AGENT_ENV agent_run_state

  SSH_AGENT_ENV="${HOME}/.ssh/agent.env"

  if [[ ! -d "${HOME}/.ssh" ]]; then
    mkdir -m 0700 "${HOME}/.ssh" || return
  fi

  if [[ -f "${SSH_AGENT_ENV}" ]]; then
    # shellcheck source=/dev/null
    source "${SSH_AGENT_ENV}" >|/dev/null
  fi

  # agent_run_state: 0=agent running w/ key; 1=agent w/o key; 2= agent not running
  agent_run_state=$(
    ssh-add -l >|/dev/null 2>&1
    echo $?
  )

  if [ ! "${SSH_AUTH_SOCK}" ] || [ "${agent_run_state}" = 2 ]; then
    (
      umask 077
      ssh-agent >|"${SSH_AGENT_ENV}"
    )
    # shellcheck source=/dev/null
    . "${SSH_AGENT_ENV}" >|/dev/null
    ssh-add
  elif [ "${SSH_AUTH_SOCK}" ] && [ "${agent_run_state}" = 1 ]; then
    ssh-add
  fi
}

# only start the agent if we don't already have a SSH_AUTH_SOCK
if [[ -n "${DOT_AUTOLOAD_SSH_AGENT:-}" ]] && { [[ -z "${SSH_AUTH_SOCK:-}" ]] || [[ ! -e "${SSH_AUTH_SOCK:-}" ]]; } && command -v ssh-agent &>/dev/null; then
  _ssh-agent-start
  unset DOT_AUTOLOAD_SSH_AGENT
fi
unset -f _ssh-agent-start

# SSH auto-completion based on entries in known_hosts and config.
if command -v complete &>/dev/null && ! complete | grep -q ' ssh$'; then
  _ssh_hosts=()
  while IFS= read -r _line; do
    [[ "$_line" == Host\ * ]] || continue
    [[ "$_line" == *no-complete* ]] && continue
    set -f
    for _h in ${_line#Host }; do
      [[ "$_h" == *['?*']* ]] || _ssh_hosts+=("$_h")
    done
    set +f
  done < <(cat "${HOME}/.ssh/config" "${HOME}"/.ssh/config.d/* 2>/dev/null)
  if [[ -e "${HOME}/.ssh/known_hosts" ]]; then
    while IFS=', ' read -r _h _; do
      _h="${_h%%]*}"
      _h="${_h#\[}"
      _h="${_h%%:*}"
      [[ "$_h" == *\|* ]] || _ssh_hosts+=("$_h")
    done < "${HOME}/.ssh/known_hosts"
  fi
  # shellcheck disable=SC2207
  IFS=$'\n' _ssh_hosts=($(printf '%s\n' "${_ssh_hosts[@]}" | sort -u))
  complete -o default -W "${_ssh_hosts[*]}" ssh
  unset _ssh_hosts _line _h
fi
