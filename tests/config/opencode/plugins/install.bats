#!/usr/bin/env bats
# Tests for config/opencode/plugins/install.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_isolated_home
  unset OPENCODE_CONFIG_DIR
  SCRIPT="${REPO_ROOT}/config/opencode/plugins/install.sh"
  PLUGIN_ROOT="${REPO_ROOT}/config/opencode/plugins"
  DEFAULT_DIR="${XDG_CONFIG_HOME}/opencode/plugins"
}

@test "install.sh: --help prints usage" {
  run "${SCRIPT}" --help
  assert_success
  assert_output --partial "Usage: install.sh [OPTION]... [PLUGIN]..."
}

@test "install.sh: links every plugin into the default config dir" {
  run "${SCRIPT}"
  assert_success
  assert_output --partial "notify: installed -> ${DEFAULT_DIR}/notify"
  assert_output --partial "Restart opencode to apply"
  for plugin in context-edit cost-guard memory notify secret-redactor statusline; do
    [[ -L "${DEFAULT_DIR}/${plugin}" ]]
    [[ "$(readlink "${DEFAULT_DIR}/${plugin}")" == "${PLUGIN_ROOT}/${plugin}" ]]
  done
}

@test "install.sh: links only the named plugins and is idempotent" {
  run "${SCRIPT}" notify memory
  assert_success
  [[ -L "${DEFAULT_DIR}/notify" ]]
  [[ ! -e "${DEFAULT_DIR}/statusline" ]]

  run "${SCRIPT}" notify
  assert_success
  assert_output "notify: already installed"
}

@test "install.sh: honors OPENCODE_CONFIG_DIR, --dir, and --profile" {
  OPENCODE_CONFIG_DIR="${BATS_TEST_TMPDIR}/oc" run "${SCRIPT}" notify
  assert_success
  [[ -L "${BATS_TEST_TMPDIR}/oc/plugins/notify" ]]

  run "${SCRIPT}" --dir="${BATS_TEST_TMPDIR}/custom" notify
  assert_success
  [[ -L "${BATS_TEST_TMPDIR}/custom/notify" ]]

  run "${SCRIPT}" -p work notify
  assert_success
  [[ -L "${XDG_CONFIG_HOME}/opencode-work/plugins/notify" ]]
}

@test "install.sh: leaves other plugins and real directories alone" {
  mkdir -p "${DEFAULT_DIR}/notify" "${DEFAULT_DIR}/someone-else"
  run "${SCRIPT}" notify
  assert_failure
  assert_output --partial "exists and is not a symlink"
  [[ -d "${DEFAULT_DIR}/notify" && ! -L "${DEFAULT_DIR}/notify" ]]

  run "${SCRIPT}"
  assert_failure
  [[ -d "${DEFAULT_DIR}/someone-else" ]]
  [[ -L "${DEFAULT_DIR}/memory" ]]
}

@test "install.sh: replaces a foreign symlink only with --force" {
  mkdir -p "${DEFAULT_DIR}" "${BATS_TEST_TMPDIR}/elsewhere"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere" "${DEFAULT_DIR}/notify"

  run "${SCRIPT}" notify
  assert_failure
  assert_output --partial "use --force to replace it"
  [[ "$(readlink "${DEFAULT_DIR}/notify")" == "${BATS_TEST_TMPDIR}/elsewhere" ]]

  run "${SCRIPT}" --force notify
  assert_success
  [[ "$(readlink "${DEFAULT_DIR}/notify")" == "${PLUGIN_ROOT}/notify" ]]
}

@test "install.sh: --uninstall removes only this repo's links" {
  "${SCRIPT}" notify memory
  mkdir -p "${BATS_TEST_TMPDIR}/elsewhere"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere" "${DEFAULT_DIR}/statusline"

  run "${SCRIPT}" --uninstall
  assert_failure
  assert_output --partial "notify: removed"
  assert_output --partial "memory: removed"
  assert_output --partial "is not a link to this repo's plugin"
  [[ ! -e "${DEFAULT_DIR}/notify" ]]
  [[ -L "${DEFAULT_DIR}/statusline" ]]
}

@test "install.sh: --list reports each plugin's state" {
  "${SCRIPT}" notify
  run "${SCRIPT}" --list
  assert_success
  assert_line "notify: installed"
  assert_line "memory: not installed"
}

@test "install.sh: rejects unknown plugins and arguments" {
  run "${SCRIPT}" bogus
  assert_failure
  assert_output --partial "unknown plugin: bogus (available: context-edit"

  run "${SCRIPT}" --bogus
  assert_failure
  assert_output --partial "unknown argument: --bogus"

  run "${SCRIPT}" --dir x --profile y
  assert_failure
  assert_output --partial "mutually exclusive"
}
