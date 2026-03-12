#!/usr/bin/env bats
# Tests for utils/wsl/native-wrappers/wslgit.
# SPDX-License-Identifier: MIT

stub_wslgit_wslpath() {
  stub_command wslpath <<'EOF'
#!/usr/bin/env bash
mode="${1:-}"
path="${@: -1}"

case "${mode}" in
  -u)
    path="${path//\\//}"
    case "${path}" in
      [cC]:/*)
        printf '%s/c/%s\n' "${WSLGIT_WIN_ROOT}" "${path#?:/}"
        ;;
      *)
        printf '%s\n' "${path}"
        ;;
    esac
    ;;
  -w)
    case "${path}" in
      "${WSLGIT_WIN_ROOT}"/c)
        printf 'C:\\\n'
        ;;
      "${WSLGIT_WIN_ROOT}"/c/*)
        rest="${path#"${WSLGIT_WIN_ROOT}/c/"}"
        printf 'C:\\%s\n' "${rest//\//\\}"
        ;;
      *)
        printf '%s\n' "${path}"
        ;;
    esac
    ;;
esac
EOF
}

setup() {
  load '../../../helpers/common'
  setup_test_bin

  export SCRIPT="${REPO_ROOT}/utils/wsl/native-wrappers/wslgit"
  export WSLGIT_WIN_ROOT="${BATS_TEST_TMPDIR}/winroot"
  mkdir -p "${WSLGIT_WIN_ROOT}/c/repo"
  stub_wslgit_wslpath
}

@test "wslgit: translates existing Windows file arguments and paths after --" {
  local translated_path="${WSLGIT_WIN_ROOT}/c/repo/file.txt"
  touch "${translated_path}"
  stub_passthrough_command git

  run bash "${SCRIPT}" checkout C:/repo/file.txt -- C:/repo/file.txt

  assert_success
  assert_output $'checkout\n'"${translated_path}"$'\n--\n'"${translated_path}"
}

@test "wslgit: converts rev-parse path output back to Windows form" {
  export WSLGIT_GIT_LOG="${BATS_TEST_TMPDIR}/git.log"
  : >"${WSLGIT_GIT_LOG}"
  stub_command git <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${WSLGIT_GIT_LOG}"
printf '%s\n' "${WSLGIT_WIN_ROOT}/c/repo"
EOF

  run bash "${SCRIPT}" -c core.quotePath=false rev-parse --show-toplevel

  assert_success
  assert_output $'C:\\repo'
  [ "$(cat "${WSLGIT_GIT_LOG}")" = "-c core.quotePath=false rev-parse --show-toplevel" ]
}
