# shellcheck shell=bash
# include solarized dir colors theme
[[ -n "${__term_solarized_light:-}" ]] && type dircolors &>/dev/null && eval "$(dircolors "${DOTFILES__ROOT}/.dotfiles/dotenv/other/dircolors.solarized.ansi-light")"
[[ -n "${__term_solarized_256:-}" ]] && type dircolors &>/dev/null && eval "$(dircolors "${DOTFILES__ROOT}/.dotfiles/dotenv/other/dircolors.solarized.256dark")"

# include special mysql client customizations
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/other/mysql-client.sh"

# include git __git_ps1 if not already included elsewhere
# shellcheck source=/dev/null
type __git_ps1 &>/dev/null || source "${DOTFILES__ROOT}/.dotfiles/dotenv/other/git-prompt.sh"

# setup ssh agent automatically
# https://help.github.com/en/github/authenticating-to-github/working-with-ssh-key-passphrases#auto-launching-ssh-agent-on-msysgit
# https://stackoverflow.com/questions/18880024/start-ssh-agent-on-login
function _ssh-agent-start() {
  local SSH_AGENT_ENV agent_run_state

  SSH_AGENT_ENV="${HOME}/.ssh/agent.env"

  # shellcheck source=/dev/null
  test -f "${SSH_AGENT_ENV}" && . "${SSH_AGENT_ENV}" >|/dev/null

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
if [[ -n "${AUTOLOAD_SSH_AGENT:-}" ]] && [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
  _ssh-agent-start
fi

# reloads env vars from tmux
function _reload-tmux-env() {
  # shellcheck disable=SC2046
  eval $(tmux show-env -s)
}
if [[ "${TERM:-}" == screen* ]] && [[ -n "${TMUX:-}" ]] && type tmux &>/dev/null; then
  __push_internal_prompt_command '_reload-tmux-env'
fi
