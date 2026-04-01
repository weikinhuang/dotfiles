#!/usr/bin/env bats
# Tests for plugins/00-bash-opts.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command stty ""
  use_mock_bin_path
}

@test "00-bash-opts: enables shell options and history defaults" {
  export DOT_BASH_RESOLVE_PATHS=1
  export HISTCONTROL=erasedups
  export HISTIGNORE=existing

  source "${REPO_ROOT}/plugins/00-bash-opts.sh"

  shopt -q nocaseglob
  shopt -q dotglob
  shopt -q cdspell
  shopt -q globstar
  shopt -q checkjobs
  shopt -q checkwinsize
  shopt -q histappend
  shopt -q cmdhist
  shopt -q histverify
  shopt -q autocd
  shopt -q dirspell
  [ "$(set -o | awk '$1 == "physical" { print $2 }')" = "on" ]
  [ "$(set -o | awk '$1 == "noclobber" { print $2 }')" = "on" ]
  [ "$(umask)" = "0022" ]
  [[ "${HISTCONTROL}" == *ignoreboth* ]]
  [[ "${HISTIGNORE}" == existing:* ]]
  [[ "${HISTIGNORE}" == *"git +([a-z])"* ]]
  [ "${HISTSIZE}" = "1000000" ]
  [ "${HISTFILESIZE}" = "1000000" ]
  [ "${HISTTIMEFORMAT}" = "%F %T " ]
  [ "${CDPATH}" = "." ]
  [ -z "${DOT_BASH_RESOLVE_PATHS+x}" ]
  [ -z "${__dot_histignore_base+x}" ]
  [ -z "${__dot_histignore_git+x}" ]
  [ -z "${__dot_histignore_local+x}" ]
  [ -z "${__dot_histignore_dev+x}" ]
}
