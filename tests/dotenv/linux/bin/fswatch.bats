#!/usr/bin/env bats
# Tests for dotenv/linux/bin/fswatch.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/fswatch"

  WATCH_TARGET="${BATS_TEST_TMPDIR}/watch-target"
  WATCH_LINK="${BATS_TEST_TMPDIR}/watch-link"
  mkdir -p "${WATCH_TARGET}"
  ln -s "${WATCH_TARGET}" "${WATCH_LINK}"

  stub_command inotifywait <<EOF
#!/usr/bin/env bash
printf '1700000000 CREATE %s/ file.txt\n' "${WATCH_TARGET}"
EOF

  stub_command handler <<'EOF'
#!/usr/bin/env bash
printf 'PWD=%s\n' "${PWD}"
printf 'ARG:%s\n' "$@"
EOF
}

@test "fswatch: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: fswatch [OPTION]... DIRECTORY COMMAND [ARG...]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "fswatch: resolves the watched directory and runs the callback from that directory" {
  run bash "${SCRIPT}" "${WATCH_LINK}" handler alpha beta
  assert_success
  assert_line --index 0 "PWD=${WATCH_TARGET}"
  assert_line --index 1 "ARG:alpha"
  assert_line --index 2 "ARG:beta"
}

@test "fswatch: returns the callback exit status when the handler fails" {
  stub_command handler <<'EOF'
#!/usr/bin/env bash
exit 7
EOF

  run bash "${SCRIPT}" "${WATCH_LINK}" handler
  assert_failure
  [[ "${status}" -eq 7 ]]
}
