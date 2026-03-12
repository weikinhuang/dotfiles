#!/usr/bin/env bash
#title              : test.sh
#description        : Run the bats test suite
#usage              : ./dev/test.sh [-q|--quiet] [bats options] [test file or dir...]
#requires           : bats bats-support bats-assert (apt install bats bats-support bats-assert)
#===============================================================================
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUIET=""

# Parse our flags before passing the rest to bats
args=()
for arg in "$@"; do
  case "$arg" in
    -q | --quiet) QUIET=1 ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

if ! command -v bats &>/dev/null; then
  echo "error: bats is not installed" >&2
  echo "hint: run tests via Docker with: ./dev/test-docker.sh" >&2
  exit 1
fi

# Ensure bats_load_library can find apt-installed helper libs (/usr/lib/bats)
# and any project-local helpers under tests/helpers.
export BATS_LIB_PATH="/usr/lib/bats${BATS_LIB_PATH:+:${BATS_LIB_PATH}}"

# Build the bats command
bats_args=(--recursive)
if [[ $# -eq 0 ]]; then
  mapfile -t test_dirs < <(find "${REPO_ROOT}/tests" -mindepth 1 -maxdepth 1 -type d ! -name 'helpers')
  bats_args+=("${test_dirs[@]}")
else
  bats_args=("$@")
fi

if [[ -z "${QUIET}" ]]; then
  exec bats "${bats_args[@]}"
fi

# Quiet mode: use TAP output, show only failures and a summary line
bats -F tap "${bats_args[@]}" 2>&1 | awk '
  /^1\.\.[0-9]+/   { total = substr($0, 4) + 0; next }
  /^not ok /        { fail++; print; collecting = 1; next }
  /^ok /            { pass++; collecting = 0; next }
  collecting        { print }
  END {
    if (fail > 0) {
      printf "\n%d/%d tests failed\n", fail, total
      exit 1
    } else {
      printf "%d tests passed\n", total
    }
  }
'
