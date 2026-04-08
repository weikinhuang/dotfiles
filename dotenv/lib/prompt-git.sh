# shellcheck shell=bash
# Git prompt caching subsystem.
# Sourced from dotenv/prompt.sh during the prompt phase.
# SPDX-License-Identifier: MIT

[[ -z "${DOT_GIT_PROMPT_CACHE_TTL_MS+x}" ]] && DOT_GIT_PROMPT_CACHE_TTL_MS=1000
[[ -z "${DOT_GIT_PROMPT_CACHE_MAX_AGE_MS+x}" ]] && DOT_GIT_PROMPT_CACHE_MAX_AGE_MS=10000
[[ -z "${DOT_GIT_PROMPT_INVALIDATE_ON_GIT+x}" ]] && DOT_GIT_PROMPT_INVALIDATE_ON_GIT=1

# Build the git format string, resolving colors at source time.
__dot_ps1_git_symbol="${DOT_PS1_SYMBOL_GIT:-${__dot_ps1_bold}$'\xD5\xAF'${__dot_ps1_reset} }"
internal::ps1-resolve-color DOT_PS1_COLOR_GIT '\[\e[38;5;135m\]' __dot_ps1_git_color
__dot_ps1_git_format=" (${__dot_ps1_git_symbol}${__dot_ps1_reset}${__dot_ps1_git_color}%s)"
unset -v __dot_ps1_git_symbol __dot_ps1_git_color

# Timestamp in milliseconds.
# Detect timing source once; EPOCHREALTIME is bash 5+, fall back to SECONDS.
if [[ -n "${EPOCHREALTIME:-}" ]]; then
  function internal::ps1-git-now-ms() {
    echo "$((${EPOCHREALTIME/./} / 1000))"
  }
else
  function internal::ps1-git-now-ms() {
    echo "$((SECONDS * 1000))"
  }
fi

# Cross-platform mtime helper (seconds since epoch).
# Detect which stat flavour is available once, then define the function.
if stat -f %m / &>/dev/null 2>&1; then
  function internal::ps1-git-mtime() {
    local path="$1"
    [[ -e "$path" ]] || { echo 0; return; }
    stat -f %m "$path" 2>/dev/null || echo 0
  }
elif stat -c %Y / &>/dev/null 2>&1; then
  function internal::ps1-git-mtime() {
    local path="$1"
    [[ -e "$path" ]] || { echo 0; return; }
    stat -c %Y "$path" 2>/dev/null || echo 0
  }
else
  function internal::ps1-git-mtime() {
    echo 0
  }
fi

# Resolve current repository gitdir by walking from $PWD upward.
function internal::ps1-gitdir() {
  local dir="$PWD"
  local dotgit line gitdir
  while true; do
    dotgit="${dir}/.git"
    if [[ -d "$dotgit" ]]; then
      echo "$dotgit"
      return 0
    fi
    if [[ -f "$dotgit" ]]; then
      IFS= read -r line <"$dotgit" || return 1
      case "$line" in
        "gitdir: "*)
          gitdir="${line#gitdir: }"
          if [[ "$gitdir" != /* ]]; then
            gitdir="${dir}/${gitdir}"
          fi
          if [[ -d "$gitdir" ]]; then
            echo "$gitdir"
            return 0
          fi
          ;;
      esac
      return 1
    fi
    [[ "$dir" == "/" ]] && break
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir="/"
  done
  return 1
}

# Invalidate cached git prompt state.
function internal::ps1-git-cache-invalidate() {
  __dot_ps1_git_cache_pwd=
  __dot_ps1_git_cache_last_check_ms=0
  __dot_ps1_git_cache_last_refresh_ms=0
  __dot_ps1_git_cache_gitdir=
  __dot_ps1_git_cache_head_mtime=0
  __dot_ps1_git_cache_index_mtime=0
  __dot_ps1_git_cache_stash_mtime=0
  __dot_ps1_git_cache_segment=
}
internal::ps1-git-cache-invalidate
internal::array-append-unique chpwd_functions internal::ps1-git-cache-invalidate

# Mark git prompt cache as dirty when the next command appears git-related.
function internal::ps1-git-preexec-mark-dirty() {
  [[ "${DOT_GIT_PROMPT_INVALIDATE_ON_GIT:-1}" == 0 ]] && return

  local cmd="${1:-}" token
  cmd="${cmd#"${cmd%%[![:space:]]*}"}"
  token="${cmd%%[[:space:];|&]*}"
  case "$token" in
    git | */git)
      __dot_ps1_git_cache_dirty=1
      ;;
    command | builtin | env)
      cmd="${cmd#"$token"}"
      cmd="${cmd#"${cmd%%[![:space:]]*}"}"
      token="${cmd%%[[:space:];|&]*}"
      if [[ "$token" == git ]] || [[ "$token" == */git ]]; then
        __dot_ps1_git_cache_dirty=1
      fi
      ;;
    sudo)
      cmd="${cmd#"$token"}"
      if [[ "$cmd" =~ (^|[[:space:]])(git|[^[:space:]]*/git)([[:space:];|&]|$) ]]; then
        __dot_ps1_git_cache_dirty=1
      fi
      ;;
  esac
}
internal::array-append-unique preexec_functions internal::ps1-git-preexec-mark-dirty

# Check once at setup time whether __git_ps1 is available.
if command -v __git_ps1 &>/dev/null; then
  __dot_ps1_has_git=1
else
  __dot_ps1_has_git=
fi

# Update cached git prompt state before PS1 is rendered.
__dot_ps1_git_segment=
function internal::ps1-git-update() {
  if [[ -z "${__dot_ps1_has_git:-}" ]]; then
    __dot_ps1_git_segment=
    return
  fi

  if [[ -n "${__dot_ps1_git_cache_dirty:-}" ]]; then
    internal::ps1-git-cache-invalidate
    unset __dot_ps1_git_cache_dirty
  fi

  local now_ms ttl_ms max_age_ms
  now_ms="$(internal::ps1-git-now-ms)"
  ttl_ms="${DOT_GIT_PROMPT_CACHE_TTL_MS:-1000}"
  max_age_ms="${DOT_GIT_PROMPT_CACHE_MAX_AGE_MS:-10000}"
  [[ "$ttl_ms" =~ ^[0-9]+$ ]] || ttl_ms=1000
  [[ "$max_age_ms" =~ ^[0-9]+$ ]] || max_age_ms=10000

  if [[ "${__dot_ps1_git_cache_pwd:-}" == "$PWD" ]] \
    && ((now_ms - __dot_ps1_git_cache_last_check_ms < ttl_ms)); then
    __dot_ps1_git_segment="${__dot_ps1_git_cache_segment:-}"
    return
  fi

  local gitdir
  if ! gitdir="$(internal::ps1-gitdir)"; then
    internal::ps1-git-cache-invalidate
    __dot_ps1_git_cache_pwd="$PWD"
    __dot_ps1_git_cache_last_check_ms="$now_ms"
    __dot_ps1_git_segment=
    return
  fi

  local head_mtime index_mtime stash_mtime
  head_mtime="$(internal::ps1-git-mtime "${gitdir}/HEAD")"
  index_mtime="$(internal::ps1-git-mtime "${gitdir}/index")"
  stash_mtime="$(internal::ps1-git-mtime "${gitdir}/refs/stash")"

  if [[ "${__dot_ps1_git_cache_gitdir:-}" == "$gitdir" ]] \
    && [[ "${__dot_ps1_git_cache_head_mtime:-0}" == "$head_mtime" ]] \
    && [[ "${__dot_ps1_git_cache_index_mtime:-0}" == "$index_mtime" ]] \
    && [[ "${__dot_ps1_git_cache_stash_mtime:-0}" == "$stash_mtime" ]] \
    && ((now_ms - __dot_ps1_git_cache_last_refresh_ms < max_age_ms)); then
    __dot_ps1_git_cache_pwd="$PWD"
    __dot_ps1_git_cache_last_check_ms="$now_ms"
    __dot_ps1_git_segment="${__dot_ps1_git_cache_segment:-}"
    return
  fi

  local segment segment_render
  segment="$(__git_ps1 "${__dot_ps1_git_format}")"
  segment_render="${segment//\\[/$'\001'}"
  segment_render="${segment_render//\\]/$'\002'}"
  segment_render="$(printf '%b' "$segment_render")"
  __dot_ps1_git_cache_pwd="$PWD"
  __dot_ps1_git_cache_last_check_ms="$now_ms"
  __dot_ps1_git_cache_last_refresh_ms="$now_ms"
  __dot_ps1_git_cache_gitdir="$gitdir"
  __dot_ps1_git_cache_head_mtime="$head_mtime"
  __dot_ps1_git_cache_index_mtime="$index_mtime"
  __dot_ps1_git_cache_stash_mtime="$stash_mtime"
  __dot_ps1_git_cache_segment="$segment_render"
  __dot_ps1_git_segment="$segment_render"
}
internal::ps1-git-update
internal::prompt-action-push internal::ps1-git-update
