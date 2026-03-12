#!/usr/bin/env bash
# shellcheck shell=bash
# Shared setup helpers for all bats test suites.

# Absolute path to the repo root (tests/helpers/ → tests/ → repo root)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

# Load bats helper libraries (installed via apt: bats-support, bats-assert)
bats_load_library bats-support
bats_load_library bats-assert

# Sets up a mock bin directory prepended to PATH that provides stubs for
# wslpath, cmd.exe, and powershell.exe.
#
# Each stub prints its received arguments one per line to stdout so that
# bats `run` captures them for assertion. wslpath performs a deterministic
# WSL→Windows path conversion so path-translation tests are predictable.
setup_mock_bin() {
  local mock_bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${mock_bin}"
  export PATH="${mock_bin}:${PATH}"

  # wslpath stub: /mnt/X/rest → X:\rest, anything else → C:\path
  cat >"${mock_bin}/wslpath" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"
if [[ "$path" =~ ^/mnt/([a-z])(/.*)?$ ]]; then
  drive="${BASH_REMATCH[1]^^}"
  rest="${BASH_REMATCH[2]:-}"
  result="${drive}:${rest}"
else
  result="C:${path}"
fi
echo "${result//\//\\}"
EOF

  # cmd.exe stub: prints each argument on its own line
  cat >"${mock_bin}/cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF

  # powershell.exe stub: prints each argument on its own line
  cat >"${mock_bin}/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF

  chmod +x "${mock_bin}/wslpath" "${mock_bin}/cmd.exe" "${mock_bin}/powershell.exe"
}

# Source a script's function definitions without executing its main entrypoint.
# Strips the final line (e.g. `internal::main "$@"`) so functions can be
# called individually in tests.
source_without_main() {
  local script="$1"
  # shellcheck disable=SC1090
  source <(head -n -1 "${script}")
}

# Override the cmd.exe stub to also cat stdin, enabling stdin-passthrough tests.
setup_mock_cmd_stdin() {
  cat >"${BATS_TEST_TMPDIR}/bin/cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
cat
EOF
  chmod +x "${BATS_TEST_TMPDIR}/bin/cmd.exe"
}
