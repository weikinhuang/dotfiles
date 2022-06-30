#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# lint with shellcheck
( git ls-files -z | xargs -0 grep -l 'shellcheck shell=\|^#!.\+sh'; git ls-files | grep '\.sh$' ) | grep -vE "^$(git ls-files -d | paste -sd "|" -)$" | grep -v '\.md$' | grep -v 'external/' | grep -v .gitlab-ci.yml | sort | uniq | xargs -n1 shellcheck -f gcc --source-path=SCRIPTDIR

# format files with shfmt
( git ls-files -z | xargs -0 grep -l 'shellcheck shell=\|^#!.\+sh'; git ls-files | grep '\.sh$' ) | grep -vE "^$(git ls-files -d | paste -sd "|" -)$" | grep -v '\.md$' | grep -v 'external/' | grep -v .gitlab-ci.yml | sort | uniq | xargs -n1 shfmt -ln bash -ci -bn -i 2 -d -w

echo "OK"
