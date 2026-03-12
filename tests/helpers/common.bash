#!/usr/bin/env bash
# shellcheck shell=bash
# Shared setup helpers for all bats test suites.

# Absolute path to the repo root (tests/helpers/ → tests/ → repo root)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

# Load bats helper libraries (installed via apt: bats-support, bats-assert)
bats_load_library bats-support
bats_load_library bats-assert

# Creates a temp bin directory prepended to PATH for command stubs used by tests.
setup_test_bin() {
  export MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${MOCK_BIN}"
  export PATH="${MOCK_BIN}:${PATH}"
}

# Prepends an arbitrary directory to PATH.
prepend_path() {
  export PATH="$1:${PATH}"
}

# Isolates HOME-backed tooling such as git global config.
setup_isolated_home() {
  export HOME="${BATS_TEST_TMPDIR}/home"
  export XDG_CONFIG_HOME="${HOME}/.config"
  export GIT_CONFIG_NOSYSTEM=1
  mkdir -p "${HOME}" "${XDG_CONFIG_HOME}"
}

# Writes an executable stub into MOCK_BIN from stdin.
stub_command() {
  local name="$1"
  cat >"${MOCK_BIN}/${name}"
  chmod +x "${MOCK_BIN}/${name}"
}

# Sets up a mock bin directory prepended to PATH that provides stubs for
# wslpath, cmd.exe, and powershell.exe.
#
# Each stub prints its received arguments one per line to stdout so that
# bats `run` captures them for assertion. wslpath performs a deterministic
# WSL→Windows path conversion so path-translation tests are predictable.
setup_mock_bin() {
  setup_test_bin

  # wslpath stub: /mnt/X/rest → X:\rest, anything else → C:\path
  cat >"${MOCK_BIN}/wslpath" <<'EOF'
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
  cat >"${MOCK_BIN}/cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF

  # powershell.exe stub: prints each argument on its own line
  cat >"${MOCK_BIN}/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF

  chmod +x "${MOCK_BIN}/wslpath" "${MOCK_BIN}/cmd.exe" "${MOCK_BIN}/powershell.exe"
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
  cat >"${MOCK_BIN}/cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
cat
EOF
  chmod +x "${MOCK_BIN}/cmd.exe"
}

# Configures a repo with deterministic author info for test commits.
configure_git_identity() {
  local repo="${1:-.}"
  git -C "${repo}" config user.name "Test User"
  git -C "${repo}" config user.email "test@example.com"
}

# Creates a non-bare git repo with a specific initial branch and test identity.
init_git_repo() {
  local repo="$1"
  local branch="${2:-main}"
  git init -q --initial-branch="${branch}" "${repo}"
  configure_git_identity "${repo}"
}

# Creates a bare git repo with a specific initial branch.
init_bare_git_repo() {
  local repo="$1"
  local branch="${2:-main}"
  git init -q --bare --initial-branch="${branch}" "${repo}"
}

# Stages and commits all changes in a repo.
git_commit_all() {
  local repo="$1"
  local message="$2"
  git -C "${repo}" add -A
  git -C "${repo}" commit -q --no-gpg-sign -m "${message}"
}

# Makes git helper scripts like git-sh-setup discoverable to sourced scripts.
add_git_exec_path() {
  prepend_path "$(git --exec-path)"
}
