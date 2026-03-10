# shellcheck shell=bash

# setup nvm base dir — prefer XDG location, fall back to ~/.nvm
if [[ -n "${XDG_CONFIG_HOME-}" ]] && [[ -s "${XDG_CONFIG_HOME}/nvm/nvm.sh" ]]; then
  NVM_DIR="${XDG_CONFIG_HOME}/nvm"
elif [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  NVM_DIR="${HOME}/.nvm"
elif [[ -n "${XDG_CONFIG_HOME-}" ]]; then
  NVM_DIR="${XDG_CONFIG_HOME}/nvm"
else
  NVM_DIR="${HOME}/.nvm"
fi

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
__cdnvm_last_scope=
__cdnvm_last_resolved=
__cdnvm_default_version=

__cdnvm_current_version() {
  if [[ -n "${NVM_BIN:-}" ]]; then
    local current_path="${NVM_BIN%/bin}"
    echo "${current_path##*/}"
    return
  fi
  echo ""
}

__cdnvm_resolve_default_version() {
  if [[ -n "${__cdnvm_default_version:-}" ]] && [[ "${__cdnvm_default_version}" != "N/A" ]]; then
    echo "${__cdnvm_default_version}"
    return
  fi

  __cdnvm_default_version="$(nvm version default 2>/dev/null || true)"
  if [[ "${__cdnvm_default_version}" == "N/A" ]]; then
    nvm alias default node >/dev/null 2>&1 || true
    __cdnvm_default_version="$(nvm version default 2>/dev/null || true)"
  fi
  echo "${__cdnvm_default_version}"
}

cdnvm() {
  local nvm_path nvmrc_path nvm_version scope current_version resolved_version default_version

  if ! command -v nvm_find_up &>/dev/null; then
    __nvm_lazy_load 2>/dev/null || true
  fi

  nvm_path="$(nvm_find_up .nvmrc | tr -d '\n')"

  # If there are no .nvmrc file, use the default nvm version
  if [[ ! "${nvm_path}" = *[^[:space:]]* ]]; then
    scope="__default__"
    current_version="$(__cdnvm_current_version)"
    default_version="$(__cdnvm_resolve_default_version)"

    if [[ "${__cdnvm_last_scope}" == "${scope}" ]] && [[ "${current_version}" == "${default_version}" ]]; then
      return
    fi

    if [[ -n "${default_version}" ]] && [[ "${current_version}" != "${default_version}" ]]; then
      nvm use default >/dev/null
    fi
    __cdnvm_last_scope="${scope}"
    __cdnvm_last_resolved="${default_version}"
    return
  fi

  nvmrc_path="${nvm_path}/.nvmrc"
  if [[ -s "${nvmrc_path}" ]] && [[ -r "${nvmrc_path}" ]]; then
    nvm_version="$(<"${nvmrc_path}")"
    scope="${nvm_path}:${nvm_version}"
    current_version="$(__cdnvm_current_version)"

    if [[ "${__cdnvm_last_scope}" == "${scope}" ]] && [[ "${current_version}" == "${__cdnvm_last_resolved}" ]]; then
      return
    fi

    # `nvm version` resolves to an installed concrete version or N/A.
    resolved_version="$(nvm version "${nvm_version}" 2>/dev/null || true)"
    if [[ "${resolved_version}" == "N/A" ]]; then
      nvm install "${nvm_version}"
      resolved_version="$(nvm version "${nvm_version}" 2>/dev/null || true)"
    elif [[ "${current_version}" != "${resolved_version}" ]]; then
      nvm use "${nvm_version}" >/dev/null
    fi

    __cdnvm_last_scope="${scope}"
    __cdnvm_last_resolved="${resolved_version}"
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
