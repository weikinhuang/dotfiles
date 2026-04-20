#!/usr/bin/env bats
# Tests for plugins/90-termux.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env

  # The plugin short-circuits unless `termux-setup-storage` is on PATH. Provide
  # a stub by default so the wrappers register; individual tests may drop it.
  stub_command termux-setup-storage <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
}

@test "90-termux: no-ops outside of Termux (termux-setup-storage missing)" {
  # Remove the sentinel command so the plugin bails out.
  rm -f "${MOCK_BIN}/termux-setup-storage"
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/90-termux.sh"

  # None of the wrapper functions should have been defined.
  [ "$(type -t pbcopy)" != "function" ]
  [ "$(type -t pbpaste)" != "function" ]
  [ "$(type -t open)" != "function" ]
  [ "$(type -t quick-toast)" != "function" ]
  [ "$(type -t keep-awake)" != "function" ]
  [ "$(type -t termux-sshd)" != "function" ]
}

@test "90-termux: registers wrapper functions when termux-setup-storage is present" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  [ "$(type -t pbcopy)" = "function" ]
  [ "$(type -t pbpaste)" = "function" ]
  [ "$(type -t open)" = "function" ]
  [ "$(type -t quick-toast)" = "function" ]
  [ "$(type -t keep-awake)" = "function" ]
  [ "$(type -t termux-sshd)" = "function" ]
}

@test "90-termux: pbcopy forwards stdin and args to termux-clipboard-set" {
  stub_command termux-clipboard-set <<'EOF'
#!/usr/bin/env bash
printf 'ARGS=%s\n' "$*"
cat
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run bash -c "source '${REPO_ROOT}/plugins/90-termux.sh' && echo 'hello from bats' | pbcopy --extra"
  assert_success
  assert_output --partial "ARGS=--extra"
  assert_output --partial "hello from bats"
}

@test "90-termux: pbpaste forwards args to termux-clipboard-get" {
  stub_command termux-clipboard-get <<'EOF'
#!/usr/bin/env bash
printf 'pasted: %s\n' "$*"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run pbpaste --foo bar
  assert_success
  assert_output "pasted: --foo bar"
}

@test "90-termux: open forwards URLs to termux-open" {
  stub_command termux-open <<'EOF'
#!/usr/bin/env bash
printf 'open: %s\n' "$@"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run open https://example.com
  assert_success
  assert_line "open: https://example.com"
}

@test "90-termux: open -h prints usage and does not invoke termux-open" {
  stub_command termux-open <<'EOF'
#!/usr/bin/env bash
printf 'SHOULD_NOT_RUN\n'
exit 1
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run open --help
  assert_success
  assert_output --partial "Usage: open"
  refute_output --partial "SHOULD_NOT_RUN"
}

@test "90-termux: quick-toast prefers termux-notification with title+body" {
  stub_command termux-notification <<'EOF'
#!/usr/bin/env bash
printf 'notification: %s\n' "$*"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run quick-toast "MyTitle" "MyBody"
  assert_success
  assert_output --partial "notification: --title MyTitle --content MyBody"
}

@test "90-termux: quick-toast uses default title when only body is supplied" {
  stub_command termux-notification <<'EOF'
#!/usr/bin/env bash
printf 'notification: %s\n' "$*"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run quick-toast "only body"
  assert_success
  assert_output --partial "--title Terminal Notification"
  assert_output --partial "--content only body"
}

@test "90-termux: quick-toast falls back to termux-toast when termux-notification is missing" {
  stub_command termux-toast <<'EOF'
#!/usr/bin/env bash
printf 'toast: %s\n' "$*"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run quick-toast "T" "B"
  assert_success
  assert_output "toast: T: B"
}

@test "90-termux: quick-toast emits a bell when no Termux tools are available" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run quick-toast "T" "B"
  assert_success
  # Bell character \a == $'\x07'
  [[ "${output}" == *$'\x07'* ]]
}

@test "90-termux: keep-awake refuses to run with no command" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run keep-awake
  assert_failure
  assert_output --partial "missing command"
}

@test "90-termux: keep-awake forwards command when wake-lock is unavailable" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run keep-awake bash -c 'echo forwarded; exit 3'
  assert_failure
  [ "${status}" -eq 3 ]
  assert_output --partial "forwarded"
}

@test "90-termux: keep-awake wraps command between wake-lock and wake-unlock" {
  local trace="${BATS_TEST_TMPDIR}/trace.log"
  : >"${trace}"
  export TRACE_LOG="${trace}"
  stub_command termux-wake-lock <<'EOF'
#!/usr/bin/env bash
printf 'LOCK\n' >>"${TRACE_LOG}"
EOF
  stub_command termux-wake-unlock <<'EOF'
#!/usr/bin/env bash
printf 'UNLOCK\n' >>"${TRACE_LOG}"
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run keep-awake bash -c 'echo "CMD" >>"${TRACE_LOG}"; exit 5'
  assert_failure
  [ "${status}" -eq 5 ]

  run cat "${trace}"
  assert_line --index 0 "LOCK"
  assert_line --index 1 "CMD"
  assert_line --index 2 "UNLOCK"
}

@test "90-termux: termux-sshd start invokes sshd and reports status" {
  local trace="${BATS_TEST_TMPDIR}/sshd.log"
  : >"${trace}"
  export SSHD_TRACE="${trace}"
  stub_command sshd <<'EOF'
#!/usr/bin/env bash
printf 'sshd started\n' >>"${SSHD_TRACE}"
EOF
  stub_command pgrep <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run termux-sshd start
  assert_success
  assert_output --partial "sshd is not running"
  run cat "${trace}"
  assert_line --index 0 "sshd started"
}

@test "90-termux: termux-sshd status prints connection info when sshd is running" {
  stub_command pgrep <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  stub_command ip <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500
    inet 192.168.42.10/24 brd 192.168.42.255 scope global wlan0
OUT
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run termux-sshd status
  assert_success
  assert_output --partial "sshd is running"
  assert_output --partial "port: 8022"
  assert_output --partial "192.168.42.10 -p 8022"
}

@test "90-termux: termux-sshd stop kills sshd" {
  stub_command pkill <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run termux-sshd stop
  assert_success
  assert_output --partial "sshd stopped"
}

@test "90-termux: termux-sshd rejects unknown actions" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run termux-sshd unknown-action
  assert_failure
  assert_output --partial "unknown action: unknown-action"
}

@test "90-termux: termux-sshd -h prints usage" {
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run termux-sshd --help
  assert_success
  assert_output --partial "Usage: termux-sshd"
  assert_output --partial "[start|stop|status]"
}

@test "90-termux: storage shortcuts register when ~/storage exists" {
  # Aliases are normally not expanded inside functions/bats tests unless
  # expand_aliases is set, but they can still be created and inspected via
  # `alias`. Enable expansion here so `type -t sdcard` reliably returns
  # `alias` on all bash versions.
  shopt -s expand_aliases
  mkdir -p "${HOME}/storage"

  source "${REPO_ROOT}/plugins/90-termux.sh"

  run alias sdcard
  assert_success
  # shellcheck disable=SC2088 # asserting the literal alias definition
  assert_output --partial "~/storage/shared"

  run alias dl
  assert_success
  # shellcheck disable=SC2088 # asserting the literal alias definition
  assert_output --partial "~/storage/downloads"
}

@test "90-termux: storage shortcuts skip when ~/storage is missing" {
  shopt -s expand_aliases
  # ~/storage does not exist in the freshly isolated HOME.
  source "${REPO_ROOT}/plugins/90-termux.sh"

  run alias sdcard
  assert_failure
  run alias dl
  assert_failure
}
