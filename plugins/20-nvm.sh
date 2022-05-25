# shellcheck shell=bash

# setup nvm base dir
NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"

# @see https://github.com/nvm-sh/nvm
if command -v nvm &>/dev/null || [[ -e "${NVM_DIR}/nvm.sh" ]]; then
  # unset NPM_PREFIX
  unset NPM_CONFIG_PREFIX

  # shellcheck disable=SC2155
  export NVM_DIR

  # load nvm if not loaded
  if ! command -v nvm &>/dev/null && [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
  fi

  # Setup nvm bash_completion
  if [[ -s "${NVM_DIR}/bash_completion" ]]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR}/bash_completion"
  fi
else
  # clean up if we're not using nvm
  unset NVM_DIR
fi
