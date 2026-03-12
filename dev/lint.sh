#!/usr/bin/env bash
# Run shellcheck and shfmt on tracked shell files.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

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

echo "==> Running shellcheck..."
get_shell_files | xargs -n1 shellcheck -f gcc --source-path=SCRIPTDIR
get_bats_files | xargs -n1 shellcheck -S warning -s bats -f gcc

echo "==> Running shfmt..."
get_shell_files | xargs -n1 shfmt -ln bash -ci -bn -i 2 -d -w

echo "==> Running shfmt on bats files..."
get_bats_files | xargs -n1 shfmt -ln bats -ci -bn -i 2 -d -w

echo "OK"
