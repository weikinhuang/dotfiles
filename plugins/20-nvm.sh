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

# ---------------------------------------------------------------------------
# Lazy loading: defer sourcing nvm.sh (~200-500ms) until first use.
# The default node version's bin dir is cached so node/npm/npx are on PATH
# immediately without loading nvm.
# ---------------------------------------------------------------------------
_nvm_cache="${DOTFILES__CONFIG_DIR}/cache/nvm_default_path"
if [[ -s "$_nvm_cache" ]]; then
  read -r _nvm_cached_path < "$_nvm_cache"
  if [[ -d "$_nvm_cached_path" ]]; then
    __push_path --prepend "$_nvm_cached_path"
  fi
  unset _nvm_cached_path
else
  # No cache yet: source nvm eagerly this one time to seed it
  if ! command -v nvm &>/dev/null && [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/bash_completion" ]] && source "${NVM_DIR}/bash_completion"
  fi
  _df_NVM_VER="$(nvm version default 2>/dev/null)"
  if [[ -n "${_df_NVM_VER}" ]] && [[ "${_df_NVM_VER}" != "N/A" ]]; then
    __push_path --prepend "${NVM_DIR}/versions/node/${_df_NVM_VER}/bin"
    printf '%s' "${NVM_DIR}/versions/node/${_df_NVM_VER}/bin" > "$_nvm_cache" 2>/dev/null
  fi
  unset _df_NVM_VER
fi
unset _nvm_cache

__nvm_lazy_load() {
  unset -f nvm node npm npx __nvm_lazy_load
  # shellcheck source=/dev/null
  [[ -s "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"
  # shellcheck source=/dev/null
  [[ -s "${NVM_DIR}/bash_completion" ]] && source "${NVM_DIR}/bash_completion"
  # refresh cached default for next startup
  local ver
  ver="$(nvm version default 2>/dev/null)"
  if [[ -n "$ver" ]] && [[ "$ver" != "N/A" ]]; then
    printf '%s' "${NVM_DIR}/versions/node/${ver}/bin" \
      > "${DOTFILES__CONFIG_DIR}/cache/nvm_default_path"
  fi
}

if ! command -v nvm &>/dev/null; then
  nvm()  { __nvm_lazy_load; nvm  "$@"; }
  node() { __nvm_lazy_load; node "$@"; }
  npm()  { __nvm_lazy_load; npm  "$@"; }
  npx()  { __nvm_lazy_load; npx  "$@"; }
fi

# automatically load nvm as needed
# https://github.com/nvm-sh/nvm#automatically-call-nvm-use
cdnvm() {
  if ! command -v nvm_find_up &>/dev/null; then
    __nvm_lazy_load 2>/dev/null || true
  fi

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

# manual upgrade function
# https://github.com/nvm-sh/nvm#manual-upgrade
function nvm-upgrade() {
  (
    # shellcheck disable=SC2164
    cd "$NVM_DIR"
    git fetch --tags origin
    git checkout "$(git describe --abbrev=0 --tags --match "v[0-9]*" "$(git rev-list --tags --max-count=1)")"
  )
}
