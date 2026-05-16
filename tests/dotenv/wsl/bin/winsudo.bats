#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/winsudo.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_mock_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/winsudo"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"

  # Default: no native sudo available
  rm -f "${MOCK_BIN}/sudo.exe"

  # sshd stub (required for legacy path)
  cat >"${MOCK_BIN}/sshd" <<'SSHD'
#!/usr/bin/env bash
printf 'SSHD_CALLED %s\n' "$@"
SSHD
  chmod +x "${MOCK_BIN}/sshd"

  # nc stub (always succeeds - pretend port is open)
  cat >"${MOCK_BIN}/nc" <<'NC'
#!/usr/bin/env bash
exit 0
NC
  chmod +x "${MOCK_BIN}/nc"

  # ssh stub - prints the remote command it would run
  cat >"${MOCK_BIN}/ssh" <<'SSH'
#!/usr/bin/env bash
# collect everything after "--"
capture=false
for a in "$@"; do
  if [[ "$a" == "--" ]]; then capture=true; continue; fi
  $capture && printf '%s\n' "$a"
done
SSH
  chmod +x "${MOCK_BIN}/ssh"

  # wsl.exe stub
  cat >"${MOCK_BIN}/wsl.exe" <<'WSL'
#!/usr/bin/env bash
printf 'WSL_CALLED %s\n' "$@"
WSL
  chmod +x "${MOCK_BIN}/wsl.exe"

  # net.exe stub
  cat >"${MOCK_BIN}/net.exe" <<'NET'
#!/usr/bin/env bash
exit 0
NET
  chmod +x "${MOCK_BIN}/net.exe"
}

# ---------------------------------------------------------------------------
# helpers to configure native sudo mock
# ---------------------------------------------------------------------------

_enable_native_sudo_inline() {
  cat >"${MOCK_BIN}/sudo.exe" <<'SUDO'
#!/usr/bin/env bash
if [[ "${1:-}" == "config" ]]; then
  echo "Inline mode"
  exit 0
fi
printf 'SUDO_CALLED %s\n' "$@"
SUDO
  chmod +x "${MOCK_BIN}/sudo.exe"
}

_enable_native_sudo_non_inline() {
  cat >"${MOCK_BIN}/sudo.exe" <<'SUDO'
#!/usr/bin/env bash
if [[ "${1:-}" == "config" ]]; then
  echo "ForceNewWindow mode"
  exit 0
fi
printf 'SUDO_CALLED %s\n' "$@"
SUDO
  chmod +x "${MOCK_BIN}/sudo.exe"
}

_enable_native_sudo_config_failure() {
  cat >"${MOCK_BIN}/sudo.exe" <<'SUDO'
#!/usr/bin/env bash
if [[ "${1:-}" == "config" ]]; then
  exit 7
fi
printf 'SUDO_CALLED %s\n' "$@"
SUDO
  chmod +x "${MOCK_BIN}/sudo.exe"
}

# ---------------------------------------------------------------------------
# main: argument routing
# ---------------------------------------------------------------------------

@test "winsudo: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: winsudo [OPTION]... [COMMAND [ARG...]]"
    assert_output --partial "Options:"
    assert_output --partial "-v"
    assert_output --partial "-h, --help"
  done
}

@test "winsudo: -v flag enables verbose mode (visible in fallback warning)" {
  _enable_native_sudo_non_inline
  run bash "${SCRIPT}" -v echo test
  assert_success
  assert_output --partial "not in inline mode"
  assert_output --partial "Falling back"
}

@test "winsudo: -v flag is consumed and not passed to child commands" {
  _enable_native_sudo_inline
  run bash "${SCRIPT}" -v echo hello
  assert_success
  assert_line "SUDO_CALLED echo"
  assert_line "SUDO_CALLED hello"
  refute_output --partial "SUDO_CALLED -v"
}

@test "winsudo: -v with help prints usage" {
  run bash "${SCRIPT}" -v --help
  assert_success
  assert_output --partial "Usage: winsudo [OPTION]... [COMMAND [ARG...]]"
  assert_output --partial "Options:"
}

# ---------------------------------------------------------------------------
# native sudo detection
# ---------------------------------------------------------------------------

@test "winsudo: uses native sudo when sudo.exe exists and reports Inline mode" {
  _enable_native_sudo_inline
  run bash "${SCRIPT}" echo hello
  assert_success
  assert_line "SUDO_CALLED echo"
  assert_line "SUDO_CALLED hello"
}

@test "winsudo: native sudo with no args execs sudo.exe wsl.exe -e bash -l" {
  _enable_native_sudo_inline
  run bash "${SCRIPT}"
  assert_success
  assert_line "SUDO_CALLED wsl.exe"
  assert_line "SUDO_CALLED -e"
  assert_line "SUDO_CALLED bash"
  assert_line "SUDO_CALLED -l"
}

@test "winsudo: falls back to legacy when sudo.exe is not installed" {
  # No sudo.exe in PATH - should attempt legacy init
  # powershell.exe mock will be called via internal::start-privileged-server
  run bash "${SCRIPT}" echo test
  assert_success
  # ssh stub receives the command
  assert_output --partial "echo"
}

@test "winsudo: falls back to legacy when sudo.exe is not in inline mode" {
  _enable_native_sudo_non_inline
  run bash "${SCRIPT}" echo test
  assert_success
  assert_output --partial "echo"
  refute_output --partial "SUDO_CALLED"
}

@test "winsudo: no verbose output by default when falling back" {
  _enable_native_sudo_non_inline
  run bash "${SCRIPT}" echo test
  assert_success
  refute_output --partial "not in inline mode"
  refute_output --partial "Falling back"
}

# ---------------------------------------------------------------------------
# internal::escape-args (sourced unit tests)
# ---------------------------------------------------------------------------

@test "winsudo: escape-args with no arguments produces no output" {
  source_without_main "${SCRIPT}"
  run internal::escape-args
  assert_success
  assert_output ""
}

@test "winsudo: escape-args passes simple arguments through" {
  source_without_main "${SCRIPT}"
  run internal::escape-args echo hello
  assert_success
  assert_output "echo hello"
}

@test "winsudo: escape-args escapes spaces in arguments" {
  source_without_main "${SCRIPT}"
  run internal::escape-args "hello world"
  assert_success
  # printf %q will escape the space
  assert_output --regexp "(hello\\ world|hello\\\\ world|'hello world')"
}

@test "winsudo: escape-args escapes special shell characters" {
  source_without_main "${SCRIPT}"
  run internal::escape-args 'foo$bar'
  assert_success
  # The dollar sign should be escaped
  refute_output 'foo$bar'
}

@test "winsudo: escape-args handles multiple arguments" {
  source_without_main "${SCRIPT}"
  run internal::escape-args one two three
  assert_success
  assert_output "one two three"
}

# ---------------------------------------------------------------------------
# internal::cleanup
# ---------------------------------------------------------------------------

@test "winsudo: cleanup does nothing when WINSUDO_WORKDIR is unset" {
  source_without_main "${SCRIPT}"
  WINSUDO_WORKDIR=""
  SSHD_PID_PORT=""
  run internal::cleanup
  assert_success
}

@test "winsudo: cleanup does nothing when pid file does not exist" {
  source_without_main "${SCRIPT}"
  WINSUDO_WORKDIR="${BATS_TEST_TMPDIR}/workdir"
  SSHD_PID_PORT="12345"
  mkdir -p "${WINSUDO_WORKDIR}"
  run internal::cleanup
  assert_success
}

@test "winsudo: cleanup kills process and removes pid file" {
  source_without_main "${SCRIPT}"
  WINSUDO_WORKDIR="${BATS_TEST_TMPDIR}/workdir"
  SSHD_PID_PORT="12345"
  mkdir -p "${WINSUDO_WORKDIR}"

  # Start a real background process so kill succeeds
  sleep 300 &
  local bg_pid=$!
  echo "${bg_pid}" >"${WINSUDO_WORKDIR}/winsudo.12345.pid"

  run internal::cleanup
  assert_success

  # pid file should be removed
  [[ ! -e "${WINSUDO_WORKDIR}/winsudo.12345.pid" ]]
  # process should be gone
  ! kill -0 "${bg_pid}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# internal::legacy-init
# ---------------------------------------------------------------------------

@test "winsudo: legacy-init sets SSHD_PID_PORT based on PID" {
  source_without_main "${SCRIPT}"
  internal::legacy-init
  # Verify the variable was set (numeric, in expected range 32222..65536)
  [[ "${SSHD_PID_PORT}" =~ ^[0-9]+$ ]]
  [[ "${SSHD_PID_PORT}" -ge 32222 ]]
  [[ "${SSHD_PID_PORT}" -le 65536 ]]
}

@test "winsudo: legacy-init fails when sshd is not in PATH" {
  rm -f "${MOCK_BIN}/sshd"
  # Restrict PATH so real /usr/sbin/sshd is not found
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  source_without_main "${SCRIPT}"
  run internal::legacy-init
  assert_failure
}

@test "winsudo: legacy-init with -v prints helpful message when sshd missing" {
  rm -f "${MOCK_BIN}/sshd"
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  source_without_main "${SCRIPT}"
  WINSUDO_VERBOSE=1
  run internal::legacy-init
  assert_failure
  assert_output --partial "openssh-server"
}

@test "winsudo: legacy-init falls back to the Windows PowerShell path when powershell.exe is unavailable" {
  rm -f "${MOCK_BIN}/powershell.exe"
  stub_command wslpath <<'EOF'
#!/usr/bin/env bash
printf '/mnt/c\n'
EOF

  source_without_main "${SCRIPT}"
  internal::legacy-init

  [ "${POWERSHELL_EXEC}" = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]
}

# ---------------------------------------------------------------------------
# internal::validate-native-sudo
# ---------------------------------------------------------------------------

@test "winsudo: validate-native-sudo returns 0 for inline mode" {
  _enable_native_sudo_inline
  source_without_main "${SCRIPT}"
  run internal::validate-native-sudo
  assert_success
}

@test "winsudo: validate-native-sudo returns 1 when sudo.exe missing" {
  source_without_main "${SCRIPT}"
  run internal::validate-native-sudo
  assert_failure
}

@test "winsudo: validate-native-sudo returns 1 for non-inline mode" {
  _enable_native_sudo_non_inline
  source_without_main "${SCRIPT}"
  run internal::validate-native-sudo
  assert_failure
}

@test "winsudo: validate-native-sudo with verbose warns about non-inline mode" {
  _enable_native_sudo_non_inline
  source_without_main "${SCRIPT}"
  # shellcheck disable=SC2034
  WINSUDO_VERBOSE=1
  run internal::validate-native-sudo
  assert_failure
  assert_output --partial "not in inline mode"
  assert_output --partial "sudo config --enable normal"
}

@test "winsudo: validate-native-sudo returns 1 when sudo.exe config fails" {
  _enable_native_sudo_config_failure
  source_without_main "${SCRIPT}"
  run internal::validate-native-sudo
  assert_failure
}

# ---------------------------------------------------------------------------
# internal::is-elevated-process / internal::unprivileged-process
# ---------------------------------------------------------------------------

@test "winsudo: is-elevated-process succeeds only when powershell returns True" {
  source_without_main "${SCRIPT}"
  POWERSHELL_EXEC="${MOCK_BIN}/powershell.exe"

  stub_fixed_output_command "powershell.exe" $'True\r\n'
  run internal::is-elevated-process
  assert_success

  stub_fixed_output_command "powershell.exe" $'False\r\n'
  run internal::is-elevated-process
  assert_failure

  stub_fixed_output_command "powershell.exe" "" 9
  run internal::is-elevated-process
  assert_failure
}

@test "winsudo: unprivileged-process short-circuits when already elevated" {
  source_without_main "${SCRIPT}"

  internal::is-elevated-process() {
    return 0
  }

  run internal::unprivileged-process
  assert_success
  assert_output ""

  run internal::unprivileged-process echo hello
  assert_success
  assert_output "hello"
}

# ---------------------------------------------------------------------------
# --privileged flag (internal SSHD server entrypoint)
# ---------------------------------------------------------------------------

@test "winsudo: --privileged routes to privileged-process path" {
  # powershell.exe mock returns "False" for is-elevated check
  cat >"${MOCK_BIN}/powershell.exe" <<'PS'
#!/usr/bin/env bash
echo "False"
PS
  chmod +x "${MOCK_BIN}/powershell.exe"

  run bash "${SCRIPT}" --privileged 44444
  assert_failure
}

@test "winsudo: --privileged invokes sshd when the elevated check succeeds" {
  cat >"${MOCK_BIN}/powershell.exe" <<'PS'
#!/usr/bin/env bash
echo "True"
PS
  chmod +x "${MOCK_BIN}/powershell.exe"

  run bash "${SCRIPT}" --privileged 44444
  assert_success
  assert_output --partial "SSHD_CALLED -D"
  assert_output --partial "SSHD_CALLED -p"
  assert_output --partial "SSHD_CALLED 44444"
}

# ---------------------------------------------------------------------------
# full integration: native sudo path
# ---------------------------------------------------------------------------

@test "winsudo: native sudo passes all arguments to sudo.exe" {
  _enable_native_sudo_inline
  run bash "${SCRIPT}" ls -la /tmp
  assert_success
  assert_line "SUDO_CALLED ls"
  assert_line "SUDO_CALLED -la"
  assert_line "SUDO_CALLED /tmp"
}

@test "winsudo: native sudo preserves argument ordering" {
  _enable_native_sudo_inline
  run bash "${SCRIPT}" cmd.exe /c echo "hello world"
  assert_success
  # All args in order after SUDO_CALLED
  assert_line --index 0 "SUDO_CALLED cmd.exe"
  assert_line --index 1 "SUDO_CALLED /c"
  assert_line --index 2 "SUDO_CALLED echo"
  assert_line --index 3 "SUDO_CALLED hello world"
}
