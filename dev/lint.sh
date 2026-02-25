#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# collect shell files tracked by git
get_shell_files() {
  local deleted
  deleted="$(git ls-files -d | paste -sd '|' -)"
  {
    git ls-files -z | xargs -0 grep -l 'shellcheck shell=\|^#!.\+sh'
    git ls-files | grep '\.sh$'
  } \
    | grep -vE "^${deleted:-.^}$" \
    | grep -v '\.md$' \
    | grep -v 'external/' \
    | grep -v '.gitlab-ci.yml' \
    | sort \
    | uniq
}

echo "==> Running shellcheck..."
get_shell_files | xargs -n1 shellcheck -f gcc --source-path=SCRIPTDIR

echo "==> Running shfmt..."
get_shell_files | xargs -n1 shfmt -ln bash -ci -bn -i 2 -d -w

echo "OK"
