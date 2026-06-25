#!/usr/bin/env bash
# Manual, WSL-only smoke test for Unicode handling in the WSL clipboard/toast
# wrappers (pbcopy, pbpaste, quick-toast).
#
# This file is intentionally NOT a *.bats file: the bats suite (run via
# dev/test-bats.sh / dev/test-bats-docker.sh in an ubuntu container) has no
# Windows host and stubs powershell.exe, so it can only assert the bash-side
# invocation. This script exercises the real powershell.exe and therefore must
# be run by hand from inside WSL:
#
#   ./tests/dotenv/wsl/wsl-unicode-smoke.sh           # programmatic checks
#   ./tests/dotenv/wsl/wsl-unicode-smoke.sh --toast   # also fire a real toast
#
# It saves and restores the Windows text clipboard around the run (non-text
# clipboard contents, e.g. an image, are not preserved).
#
# Exit codes: 0 = all checks passed, 1 = a check failed, 77 = skipped (not WSL
# / no powershell.exe), matching the autotools "skipped test" convention.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN_DIR="${REPO_ROOT}/dotenv/wsl/bin"

SHOW_TOAST=0
case "${1:-}" in
  -h | --help)
    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --toast)
    SHOW_TOAST=1
    ;;
  "") ;;
  *)
    echo "wsl-unicode-smoke: unknown argument: $1" >&2
    exit 1
    ;;
esac

if ! grep -qi microsoft /proc/version 2>/dev/null || ! command -v powershell.exe >/dev/null 2>&1; then
  echo "SKIP: not running under WSL with powershell.exe available" >&2
  exit 77
fi

pass=0
fail=0

report() {
  local ok="$1" name="$2"
  if [[ "${ok}" == "0" ]]; then
    printf 'PASS: %s\n' "${name}"
    pass=$((pass + 1))
  else
    printf 'FAIL: %s\n' "${name}"
    fail=$((fail + 1))
  fi
}

# Preserve and restore the user's text clipboard.
saved_clip="$("${BIN_DIR}/pbpaste" || true)"
restore_clip() {
  [[ -n "${saved_clip}" ]] || return 0
  printf '%s' "${saved_clip}" | "${BIN_DIR}/pbcopy" || true
}
trap restore_clip EXIT

payload=$'\u03c0 \u00b7 caf\u00e9 \u65e5\u672c\u8a9e \U0001f389 plus ASCII'

# 1. pbcopy -> pbpaste end-to-end round-trip.
printf '%s' "${payload}" | "${BIN_DIR}/pbcopy"
got="$("${BIN_DIR}/pbpaste")"
if [[ "${got}" == "${payload}" ]]; then
  report 0 "pbcopy/pbpaste round-trip preserves Unicode"
else
  report 1 "pbcopy/pbpaste round-trip preserves Unicode"
  printf '  sent: %s\n  got : %s\n' "${payload}" "${got}" >&2
fi

# 2. pbpaste emits real UTF-8 bytes (not a legacy code page). U+03C0 must be the
#    two-byte sequence CF 80; the broken path emitted a single bogus byte.
hex="$("${BIN_DIR}/pbpaste" | head -c 2 | od -An -tx1 | tr -d ' \n')"
if [[ "${hex}" == "cf80" ]]; then
  report 0 "pbpaste outputs UTF-8 encoded bytes (cf80 for pi)"
else
  report 1 "pbpaste outputs UTF-8 encoded bytes (cf80 for pi)"
  printf '  leading bytes: %s (expected cf80)\n' "${hex}" >&2
fi

# 3. quick-toast's -EncodedCommand pipeline carries Unicode into PowerShell.
#    Reproduce the exact encode path (UTF-16LE -> base64 -> -EncodedCommand) but
#    have the script echo the title back instead of showing a toast.
title=$'\u03c0 title \U0001f389'
read -r -d '' probe_script <<EOF || true
\$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new(\$false)
\$TITLE = "${title}"
Write-Output "TITLE=\$TITLE"
EOF
encoded="$(printf '%s' "${probe_script}" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
decoded="$(powershell.exe -NoProfile -EncodedCommand "${encoded}" | sed 's/\r$//')"
if [[ "${decoded}" == *"TITLE=${title}"* ]]; then
  report 0 "quick-toast -EncodedCommand carries Unicode into PowerShell"
else
  report 1 "quick-toast -EncodedCommand carries Unicode into PowerShell"
  printf '  decoded: %s\n' "${decoded}" >&2
fi

# 4. Optional: actually fire a toast for visual confirmation.
if [[ "${SHOW_TOAST}" == "1" ]]; then
  "${BIN_DIR}/quick-toast" $'\u03c0 \u00b7 quick-toast' $'caf\u00e9 \u65e5\u672c\u8a9e \U0001f389'
  echo "INFO: toast fired - confirm the title/body render correctly on screen" >&2
fi

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]
