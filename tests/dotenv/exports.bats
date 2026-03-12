#!/usr/bin/env bats
# Tests for dotenv/exports.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  export HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${HOME}"

  __find_editor() {
    echo "fallback-editor"
  }
}

@test "exports: assigns locale, completion, XDG defaults, and editor fallbacks" {
  unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
  unset EDITOR VISUAL PAGER
  export COMP_WORDBREAKS=':='

  source "${REPO_ROOT}/dotenv/exports.sh"

  [[ "${LC_ALL}" == "en_US.UTF-8" ]]
  [[ "${LANG}" == "en_US.UTF-8" ]]
  [[ "${XDG_CONFIG_HOME}" == "${HOME}/.config" ]]
  [[ "${XDG_DATA_HOME}" == "${HOME}/.local/share" ]]
  [[ "${XDG_STATE_HOME}" == "${HOME}/.local/state" ]]
  [[ "${XDG_CACHE_HOME}" == "${HOME}/.cache" ]]
  [[ "${COMP_CVS_REMOTE}" == "1" ]]
  [[ "${COMP_CONFIGURE_HINTS}" == "1" ]]
  [[ "${COMP_TAR_INTERNAL_PATHS}" == "1" ]]
  [[ "${EDITOR}" == "fallback-editor" ]]
  [[ "${VISUAL}" == "fallback-editor" ]]
  [[ "${PAGER}" == "less" ]]
  [[ "${COMP_WORDBREAKS}" == ":" ]]
}

@test "exports: preserves explicit editor and XDG settings" {
  export XDG_CONFIG_HOME="${BATS_TEST_TMPDIR}/config"
  export XDG_DATA_HOME="${BATS_TEST_TMPDIR}/data"
  export XDG_STATE_HOME="${BATS_TEST_TMPDIR}/state"
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"
  export EDITOR="nvim"
  export VISUAL="code --wait"
  export PAGER="more"
  export COMP_WORDBREAKS='*='

  source "${REPO_ROOT}/dotenv/exports.sh"

  [[ "${XDG_CONFIG_HOME}" == "${BATS_TEST_TMPDIR}/config" ]]
  [[ "${XDG_DATA_HOME}" == "${BATS_TEST_TMPDIR}/data" ]]
  [[ "${XDG_STATE_HOME}" == "${BATS_TEST_TMPDIR}/state" ]]
  [[ "${XDG_CACHE_HOME}" == "${BATS_TEST_TMPDIR}/cache" ]]
  [[ "${EDITOR}" == "nvim" ]]
  [[ "${VISUAL}" == "code --wait" ]]
  [[ "${PAGER}" == "more" ]]
  [[ "${COMP_WORDBREAKS}" == "*" ]]
}

@test "exports: defaults VISUAL from an explicit EDITOR when VISUAL is unset" {
  unset VISUAL
  export EDITOR="nvim"

  source "${REPO_ROOT}/dotenv/exports.sh"

  [[ "${EDITOR}" == "nvim" ]]
  [[ "${VISUAL}" == "nvim" ]]
}
