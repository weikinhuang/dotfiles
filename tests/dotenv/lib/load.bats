#!/usr/bin/env bats
# Tests for dotenv/lib/load.sh.
# SPDX-License-Identifier: MIT

write_trace_file() {
  local path="$1"
  local tag="$2"
  mkdir -p "$(dirname "${path}")"
  cat >"${path}" <<EOF
DOT_LOAD_TRACE="\${DOT_LOAD_TRACE:+\${DOT_LOAD_TRACE}:}${tag}"
EOF
}

setup() {
  load '../../helpers/common'
  setup_isolated_home

  export DOTFILES__ROOT="${BATS_TEST_TMPDIR}/root"
  mkdir -p "${DOTFILES__ROOT}/.dotfiles/dotenv" "${HOME}/.bash_local.d"

  source "${REPO_ROOT}/dotenv/lib/load.sh"
}

@test "load: dot-load-hook runs array hooks and named hooks" {
  DOT_LOAD_TRACE=

  load_hook_one() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}one"
  }
  load_hook_two() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}two"
  }
  dotfiles_hook_aliases_pre() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}named"
  }
  # shellcheck disable=SC2034
  dotfiles_hook_aliases_pre_functions=(load_hook_one load_hook_two)

  internal::load-hook-run pre aliases

  [ "${DOT_LOAD_TRACE}" = 'one:two:named' ]
}

@test "load: dot-load sources matching files in environment order with home overrides last" {
  export DOTENV=linux
  export DOT___IS_WSL=1
  export DOT___IS_SSH=1
  DOT_LOAD_TRACE=

  dotfiles_hook_aliases_pre() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}pre"
  }
  dotfiles_hook_aliases_post() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}post"
  }

  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/aliases.sh" common
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/linux/aliases.sh" linux
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/aliases.sh" wsl
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/aliases.sh" ssh
  write_trace_file "${HOME}/.aliases" home

  internal::load-phase aliases

  [ "${DOT_LOAD_TRACE}" = 'pre:common:linux:wsl:ssh:home:post' ]
}

@test "load: dot-load includes wsl2, tmux, and screen layers in order when enabled" {
  export DOTENV=linux
  export DOT___IS_WSL=1
  export DOT___IS_WSL2=1
  export DOT___IS_SCREEN=1
  export DOT___IS_SSH=1
  export TMUX=1
  export TERM="tmux-256color"
  DOT_LOAD_TRACE=

  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/exports.sh" common
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/linux/exports.sh" linux
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/exports.sh" wsl
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/exports.sh" wsl2
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/exports.sh" tmux
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/exports.sh" screen
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/exports.sh" ssh

  internal::load-phase exports

  [ "${DOT_LOAD_TRACE}" = 'common:linux:wsl:wsl2:tmux:screen:ssh' ]
}

@test "load: dot-load-plugin skips disabled plugins and unsets the disable variable" {
  local plugin="${BATS_TEST_TMPDIR}/demo-plugin.sh"
  DOT_LOAD_TRACE=
  cat >"${plugin}" <<'EOF'
DOT_LOAD_TRACE=loaded
EOF

  export DOT_PLUGIN_DISABLE_demo_plugin=1

  internal::load-plugin "${plugin}"

  [ -z "${DOT_LOAD_TRACE}" ]
  [ "${DOT_PLUGIN_DISABLE_demo_plugin}" = "1" ]
}

@test "load: dot-load-plugin strips numeric ordering prefixes from disable names" {
  local plugin="${BATS_TEST_TMPDIR}/10-demo-plugin.sh"
  DOT_LOAD_TRACE=
  cat >"${plugin}" <<'EOF'
DOT_LOAD_TRACE=loaded
EOF

  export DOT_PLUGIN_DISABLE_demo_plugin=1

  internal::load-plugin "${plugin}"

  [ -z "${DOT_LOAD_TRACE}" ]
  [ "${DOT_PLUGIN_DISABLE_demo_plugin}" = "1" ]
}

@test "load: dot-load-plugins loads only the baseline built-ins by default" {
  DOT_LOAD_TRACE=
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/00-bash-opts.sh" bash-opts
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/00-chpwd-hook.sh" chpwd-hook
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/10-extra.sh" extra

  internal::load-plugins

  [ "${DOT_LOAD_TRACE}" = 'bash-opts:chpwd-hook' ]
}

@test "load: dot-load-plugins sorts built-in and local plugins together" {
  DOT_LOAD_TRACE=
  export DOT_INCLUDE_BUILTIN_PLUGINS=1

  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/10-zeta.sh" zeta
  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/15-mid.sh" mid
  write_trace_file "${HOME}/.bash_local.d/05-alpha.plugin" alpha
  write_trace_file "${HOME}/.bash_local.d/20-omega.plugin" omega

  internal::load-plugins

  [ "${DOT_LOAD_TRACE}" = 'alpha:zeta:mid:omega' ]
}

@test "load: dot-load-plugins runs plugin hooks and unsets builtin-plugin flags" {
  DOT_LOAD_TRACE=
  export DOT_INCLUDE_BUILTIN_PLUGINS=1

  dotfiles_hook_plugin_pre() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}pre"
  }
  dotfiles_hook_plugin_post() {
    DOT_LOAD_TRACE="${DOT_LOAD_TRACE:+${DOT_LOAD_TRACE}:}post"
  }

  write_trace_file "${DOTFILES__ROOT}/.dotfiles/plugins/00-bash-opts.sh" bash-opts

  internal::load-plugins

  [ "${DOT_LOAD_TRACE}" = 'pre:bash-opts:post' ]
  [ -z "${DOT_INCLUDE_BUILTIN_PLUGINS+x}" ]
}

@test "load: dot-load-cleanup removes its helper functions" {
  internal::load-cleanup

  [ "$(type -t internal::load-phase || true)" = "" ]
  [ "$(type -t internal::load-hook-run || true)" = "" ]
  [ "$(type -t internal::load-plugins || true)" = "" ]
}
