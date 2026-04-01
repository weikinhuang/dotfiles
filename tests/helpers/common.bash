#!/usr/bin/env bash
# shellcheck shell=bash
# Shared setup helpers for Bats test suites.
# SPDX-License-Identifier: MIT

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

# Sets up the shared environment used by sourced plugin tests.
setup_plugin_test_env() {
  setup_test_bin
  setup_isolated_home

  export DOTENV="${DOTENV:-linux}"
  export DOTFILES__ROOT="${BATS_TEST_TMPDIR}/root"
  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"

  mkdir -p "${DOTFILES__ROOT}" "${DOTFILES__CONFIG_DIR}/cache"
  ln -s "${REPO_ROOT}" "${DOTFILES__ROOT}/.dotfiles"

  # shellcheck disable=SC2034
  __dot_prompt_actions=()
  # shellcheck disable=SC2034
  chpwd_functions=()
  # shellcheck disable=SC2034
  dotfiles_complete_functions=()
  # shellcheck disable=SC2034
  dotfiles_hook_plugin_post_functions=()
  DOT_TEST_CACHED_COMPLETIONS=()
  DOT_TEST_CACHED_EVALS=()
}

# Minimal internal::path-push shim for plugin tests.
internal::path-push() {
  local mode=append
  if [[ "${1:-}" == --prepend ]]; then
    mode=prepend
    shift
  elif [[ "${1:-}" == --append ]]; then
    shift
  fi

  local dir="${1:-}"
  [[ -n "${dir}" ]] || return 0

  case ":${PATH}:" in
    *":${dir}:"*)
      return 0
      ;;
  esac

  if [[ "${mode}" == prepend ]]; then
    export PATH="${dir}${PATH:+:${PATH}}"
  else
    export PATH="${PATH:+${PATH}:}${dir}"
  fi
}

# Records prompt hooks registered by plugins.
internal::prompt-action-push() {
  __dot_prompt_actions+=("$1")
}

# Records cached completion calls from plugins.
internal::cached-completion() {
  DOT_TEST_CACHED_COMPLETIONS+=("$1|$2")
}

# Evaluates cached shell snippets and records the request.
internal::cached-eval() {
  local key="$1"
  local command_string="$2"
  local output

  DOT_TEST_CACHED_EVALS+=("${key}|${command_string}")
  output="$(eval "${command_string}")" || return
  [[ -n "${output}" ]] && eval "${output}"
}

internal::cache-write-atomic() {
  local cache_file="$1"
  local command_string="$2"
  local tmp_file="${cache_file}.tmp.$$.$RANDOM"

  mkdir -p "${cache_file%/*}" || return 1
  if eval "${command_string}" >"${tmp_file}" 2>/dev/null; then
    mv -f "${tmp_file}" "${cache_file}"
    return 0
  fi
  rm -f "${tmp_file}"
  return 1
}

# Writes an executable file at an arbitrary path from stdin.
write_executable() {
  local path="$1"
  mkdir -p "$(dirname "${path}")"
  cat >"${path}"
  chmod +x "${path}"
}

# Writes an executable stub into MOCK_BIN from stdin.
stub_command() {
  local name="$1"
  write_executable "${MOCK_BIN}/${name}"
}

# Restricts PATH to the mock bin plus /bin for core test tools like bash/cat.
use_mock_bin_path() {
  export PATH="${MOCK_BIN}:/bin"
}

# Stubs a command that prints each argument on its own line.
stub_passthrough_command() {
  local name="$1"
  stub_command "${name}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
}

# Stubs a command that prints its own name and then each argument.
stub_named_passthrough_command() {
  local name="$1"
  stub_command "${name}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "${name}"
printf '%s\n' "\$@"
EOF
}

# Stubs a command that prints each argument and then forwards stdin.
stub_passthrough_command_with_stdin() {
  local name="$1"
  stub_command "${name}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
cat
EOF
}

# Stubs a command that prints VAR=value and then each argument.
stub_env_passthrough_command() {
  local name="$1"
  local env_name="$2"
  stub_command "${name}" <<EOF
#!/usr/bin/env bash
printf '${env_name}=%s\n' "\${${env_name}:-}"
printf '%s\n' "\$@"
EOF
}

# Stubs a command that prints VAR=value, each argument, and then stdin.
stub_env_passthrough_command_with_stdin() {
  local name="$1"
  local env_name="$2"
  stub_command "${name}" <<EOF
#!/usr/bin/env bash
printf '${env_name}=%s\n' "\${${env_name}:-}"
printf '%s\n' "\$@"
cat
EOF
}

# Stubs a command that writes a fixed string to stdout.
stub_fixed_output_command() {
  local name="$1"
  local output="$2"
  local status="${3:-0}"
  stub_command "${name}" <<EOF
#!/usr/bin/env bash
printf '%s' $(printf '%q' "${output}")
exit ${status}
EOF
}

# Stubs curl for clipboard-server tests.
# Flags:
#   --stdin      Forward stdin to stdout for non-/ping requests.
#   --fail-ping  Make /ping exit non-zero instead of succeeding.
stub_clipboard_server_curl() {
  local passthrough_stdin=
  local ping_status=0
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --stdin)
        passthrough_stdin=1
        ;;
      --fail-ping)
        ping_status=1
        ;;
    esac
  done
  stub_command "curl" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [[ "\$arg" == */ping ]]; then
    exit ${ping_status}
  fi
done
printf '%s\n' "\$@"
$(if [[ -n "${passthrough_stdin}" ]]; then echo 'cat'; fi)
EOF
}

# Starts a minimal Unix socket listener at the requested path and prints its pid.
start_unix_socket_listener() {
  local socket_path="$1"
  perl -MSocket -e '
    use strict;
    use warnings;
    my $path = shift;
    unlink $path;
    socket(my $sock, AF_UNIX, SOCK_STREAM, 0) or die $!;
    bind($sock, sockaddr_un($path)) or die $!;
    listen($sock, SOMAXCONN) or die $!;
    $SIG{TERM} = sub { unlink $path; exit 0 };
    $SIG{INT} = sub { unlink $path; exit 0 };
    while (accept(my $client, $sock)) {
      close $client;
    }
  ' "${socket_path}" </dev/null >/dev/null 2>&1 &
  local pid=$!
  local _i
  for _i in {1..50}; do
    if [[ -S "${socket_path}" ]]; then
      echo "${pid}"
      return 0
    fi
    sleep 0.02
  done
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  return 1
}

# Creates a fake Windows root anchored at BATS_TEST_TMPDIR for WSL path tests.
setup_mock_windows_root() {
  export MOCK_WIN_ROOT="${BATS_TEST_TMPDIR}/winroot"
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c"
}

# Stubs wslpath for tests that only need generic C: and /mnt/X conversions.
stub_mock_wslpath() {
  stub_command "wslpath" <<'EOF'
#!/usr/bin/env bash
mode="${1:-}"
path="${@: -1}"
case "$mode" in
  -u | -ua)
    case "$path" in
      [cC]:/)
        printf '%s/mnt/c/\n' "${MOCK_WIN_ROOT}"
        ;;
      [cC]:)
        printf '%s/mnt/c\n' "${MOCK_WIN_ROOT}"
        ;;
      [cC]:/*)
        printf '%s/mnt/c/%s\n' "${MOCK_WIN_ROOT}" "${path#?:/}"
        ;;
    esac
    ;;
  -w | -wa)
    if [[ "$path" == /wsl/* ]]; then
      rest="${path#/wsl}"
      printf '\\\\wsl$\\Ubuntu%s\n' "${rest//\//\\}"
    elif [[ "$path" =~ ^/mnt/([a-zA-Z])(/.*)?$ ]]; then
      drive="${BASH_REMATCH[1]^^}"
      rest="${BASH_REMATCH[2]:-}"
      printf '%s\n' "${drive}:${rest//\//\\}"
    else
      printf '%s\n' "C:${path//\//\\}"
    fi
    ;;
esac
EOF
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
  write_executable "${MOCK_BIN}/wslpath" <<'EOF'
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
  stub_passthrough_command "cmd.exe"

  # powershell.exe stub: prints each argument on its own line
  stub_passthrough_command "powershell.exe"
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
  stub_passthrough_command_with_stdin "cmd.exe"
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
