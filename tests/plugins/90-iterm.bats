#!/usr/bin/env bats
# Tests for plugins/90-iterm.sh.
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2154  # dotfiles_complete_functions is populated by setup_plugin_test_env

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "90-iterm: skips registration on Linux even when ITERM_SESSION_ID is set" {
  export DOTENV=linux
  export ITERM_SESSION_ID=session-1

  source "${REPO_ROOT}/plugins/90-iterm.sh"

  [ "${#dotfiles_complete_functions[@]}" -eq 0 ]
}

@test "90-iterm: skips registration on macOS without ITERM_SESSION_ID" {
  export DOTENV=darwin
  unset ITERM_SESSION_ID

  source "${REPO_ROOT}/plugins/90-iterm.sh"

  [ "${#dotfiles_complete_functions[@]}" -eq 0 ]
}

@test "90-iterm: registers the loader when the integration script exists" {
  export DOTENV=darwin
  export ITERM_SESSION_ID=w0t0p0:ABCDEF

  local fake_integration="${BATS_TEST_TMPDIR}/iterm2_shell_integration.bash"
  printf '# fake iTerm integration marker\nINTERNAL_ITERM_LOADED=1\n' >"${fake_integration}"

  local patched_plugin="${BATS_TEST_TMPDIR}/90-iterm.sh"
  sed "s|/Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash|${fake_integration}|g" \
    "${REPO_ROOT}/plugins/90-iterm.sh" >"${patched_plugin}"

  # shellcheck source=/dev/null
  source "${patched_plugin}"

  [ "${#dotfiles_complete_functions[@]}" -eq 1 ]
  [ "${dotfiles_complete_functions[0]}" = "internal::iterm-load-integration" ]

  internal::iterm-load-integration
  [ "${INTERNAL_ITERM_LOADED:-}" = "1" ]
  run declare -F internal::iterm-load-integration
  assert_failure
}

@test "90-iterm: does not register a loader when the integration script is missing" {
  export DOTENV=darwin
  export ITERM_SESSION_ID=w0t0p0:ABCDEF

  local patched_plugin="${BATS_TEST_TMPDIR}/90-iterm.sh"
  sed "s|/Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash|${BATS_TEST_TMPDIR}/does-not-exist.bash|g" \
    "${REPO_ROOT}/plugins/90-iterm.sh" >"${patched_plugin}"

  # shellcheck source=/dev/null
  source "${patched_plugin}"

  [ "${#dotfiles_complete_functions[@]}" -eq 0 ]
  run declare -F internal::iterm-load-integration
  assert_failure
}
