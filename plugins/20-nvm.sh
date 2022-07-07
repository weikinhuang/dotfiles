# shellcheck shell=bash

# setup nvm base dir
NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"

# @see https://github.com/nvm-sh/nvm
if ! command -v nvm &>/dev/null && [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
  # clean up if we're not using nvm
  unset NVM_DIR

  return
fi

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

# try to use default stable
_df_NVM_VER="$(nvm version default)"
if [[ -n "${_df_NVM_VER}" ]]; then
  # minor optimization, "nvm use" takes ~200ms to run
  __push_path --prepend "${NVM_DIR}/versions/node/${_df_NVM_VER}/bin"
  # let this be taken care of in the chpwd func
  # nvm use default &>/dev/null
fi
unset _df_NVM_VER

# automatically load nvm as needed
# https://github.com/nvm-sh/nvm#automatically-call-nvm-use
cdnvm() {
  nvm_path=$(nvm_find_up .nvmrc | tr -d '\n')

  # If there are no .nvmrc file, use the default nvm version
  if [[ ! $nvm_path = *[^[:space:]]* ]]; then

    local default_version
    default_version=$(nvm version default)

    # If there is no default version, set it to `node`
    # This will use the latest version on your machine
    if [[ $default_version == "N/A" ]]; then
      nvm alias default node
      default_version=$(nvm version default)
    fi

    # If the current version is not the default version, set it to use the default version
    if [[ $(nvm current) != "$default_version" ]]; then
      nvm use default
    fi

  elif [[ -s $nvm_path/.nvmrc && -r $nvm_path/.nvmrc ]]; then
    local nvm_version
    nvm_version=$(<"$nvm_path"/.nvmrc)

    local locally_resolved_nvm_version
    # `nvm ls` will check all locally-available versions
    # If there are multiple matching versions, take the latest one
    # Remove the `->` and `*` characters and spaces
    # `locally_resolved_nvm_version` will be `N/A` if no local versions are found
    locally_resolved_nvm_version=$(nvm ls --no-colors "$nvm_version" | tail -1 | tr -d '\->*' | tr -d '[:space:]')

    # If it is not already installed, install it
    # `nvm install` will implicitly use the newly-installed version
    if [[ "$locally_resolved_nvm_version" == "N/A" ]]; then
      nvm install "$nvm_version"
    elif [[ $(nvm current) != "$locally_resolved_nvm_version" ]]; then
      nvm use "$nvm_version"
    fi
  fi
}
chpwd_functions+=(cdnvm)
