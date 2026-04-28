#!/usr/bin/env bash
# Run shellcheck and shfmt on tracked shell files.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

FIX=

print_help() {
  cat <<'EOF'
Usage: dev/lint.sh [OPTION]...
Run shellcheck + shfmt on tracked shell and bats files.

Options:
  -f, --fix     rewrite files in place to match shfmt style (default: diff only)
  -h, --help    display this help and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f | --fix)
      FIX=1
      ;;
    -h | --help)
      print_help
      exit 0
      ;;
    *)
      echo "lint.sh: unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
  shift
done

SHFMT_MODE=(-d)
if [[ -n "${FIX}" ]]; then
  SHFMT_MODE=(-w)
fi

# collect shell files tracked by git
get_shell_files() {
  local deleted
  deleted="$(git ls-files -d | paste -sd '|' -)"
  {
    git ls-files -z \
      | grep -zv 'external/' \
      | grep -zv '\.bats$' \
      | xargs -0 grep -l 'shellcheck shell=\|^#!.\+sh' 2>/dev/null || true
    git ls-files | grep '\.sh$'
  } \
    | grep -vE "^${deleted:-.^}$" \
    | grep -v '\.md$' \
    | grep -v 'external/' \
    | grep -v '.gitlab-ci.yml' \
    | sort \
    | uniq
}

get_bats_files() {
  local deleted
  deleted="$(git ls-files -d | paste -sd '|' -)"
  git ls-files '*.bats' \
    | grep -vE "^${deleted:-.^}$" \
    | sort \
    | uniq
}

DOCKER_ARGS=(-i --rm -u "$(id -u):$(id -g)" --read-only --cap-drop all -v "${PWD}:/mnt" -w /mnt)

echo "==> Running shellcheck..."
get_shell_files | xargs -n1 shellcheck -f gcc --source-path=SCRIPTDIR
# --norc disables .shellcheckrc (external-sources=true) for bats files.
# Without this, shellcheck 0.11 follows each `source "${REPO_ROOT}/..."` inside
# every `@test` block and consumes 10GB+ per file.
get_bats_files | xargs -n1 docker run "${DOCKER_ARGS[@]}" koalaman/shellcheck:v0.11.0 --norc -S warning -s bats -f gcc

echo "==> Running shfmt..."
get_shell_files | xargs -n1 docker run "${DOCKER_ARGS[@]}" mvdan/shfmt:v3.13.1 -ln bash -ci -bn -i 2 "${SHFMT_MODE[@]}"

echo "==> Running shfmt on bats files..."
get_bats_files | xargs -n1 docker run "${DOCKER_ARGS[@]}" mvdan/shfmt:v3.13.1 -ln bats -ci -bn -i 2 "${SHFMT_MODE[@]}"

echo "OK"
