#!/usr/bin/env bats
# Tests for dotenv/wsl/exports.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'

  wslpath() {
    printf '/mnt/c/\n'
  }

  __push_path() {
    PATH="${PATH:+${PATH}:}$1"
    export PATH
  }
}

@test "wsl/exports: appends Windows tool directories and sets the browser" {
  export PATH="/usr/bin"

  source "${REPO_ROOT}/dotenv/wsl/exports.sh"

  [[ "${PATH}" == *"/mnt/c/Windows/system32"* ]]
  [[ "${PATH}" == *"/mnt/c/Windows"* ]]
  [[ "${PATH}" == *"/mnt/c/Windows/System32/Wbem"* ]]
  [[ "${PATH}" == *"/mnt/c/Windows/System32/WindowsPowerShell/v1.0"* ]]
  [[ "${BROWSER}" == "winstart" ]]
  [[ "$(type -t __wsl_has_path 2>/dev/null || true)" == "" ]]
}

@test "wsl/exports: falls back to /mnt/c when wslpath cannot resolve the Windows root" {
  wslpath() {
    return 1
  }

  export PATH="/usr/bin"

  source "${REPO_ROOT}/dotenv/wsl/exports.sh"

  [[ "${PATH}" == *"/mnt/c/Windows/system32"* ]]
  [[ "${PATH}" == *"/mnt/c/Windows/System32/Wbem"* ]]
}

@test "wsl/exports: avoids re-adding existing Windows paths with different casing" {
  export PATH="/usr/bin:/mnt/c/WINDOWS/system32:/mnt/c/windows"

  source "${REPO_ROOT}/dotenv/wsl/exports.sh"

  local lowered
  lowered="$(tr ':' '\n' <<<"${PATH}" | tr '[:upper:]' '[:lower:]')"
  [[ "$(grep -xc '/mnt/c/windows/system32' <<<"${lowered}")" -eq 1 ]]
  [[ "$(grep -xc '/mnt/c/windows' <<<"${lowered}")" -eq 1 ]]
}

@test "wsl/exports: avoids re-adding existing Windows paths that already have trailing slashes" {
  export PATH="/usr/bin:/mnt/c/windows/system32/:/mnt/c/windows/:/mnt/c/windows/system32/wbem/:/mnt/c/windows/system32/windowspowershell/v1.0/"

  source "${REPO_ROOT}/dotenv/wsl/exports.sh"

  local lowered
  lowered="$(tr ':' '\n' <<<"${PATH}" | tr '[:upper:]' '[:lower:]')"
  [[ "$(grep -xc '/mnt/c/windows/system32/' <<<"${lowered}")" -eq 1 ]]
  [[ "$(grep -xc '/mnt/c/windows/' <<<"${lowered}")" -eq 1 ]]
  [[ "$(grep -xc '/mnt/c/windows/system32/wbem/' <<<"${lowered}")" -eq 1 ]]
  [[ "$(grep -xc '/mnt/c/windows/system32/windowspowershell/v1.0/' <<<"${lowered}")" -eq 1 ]]
}
