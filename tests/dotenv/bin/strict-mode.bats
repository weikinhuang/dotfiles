#!/usr/bin/env bats
# Tests for strict mode headers in bash bin scripts.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
}

@test "bin scripts: bash entrypoints enable strict mode and safe IFS" {
  local script

  while IFS= read -r script; do
    [[ "$(sed -n '1p' "${script}")" == '#!/usr/bin/env bash' ]] || continue

    grep -Fxq 'set -euo pipefail' "${script}" \
      || fail "${script#${REPO_ROOT}/} is missing set -euo pipefail"
    grep -Fxq "IFS=\$'\\n\\t'" "${script}" \
      || fail "${script#${REPO_ROOT}/} is missing IFS=\$'\\n\\t'"
  done < <(find "${REPO_ROOT}/dotenv" -path '*/bin/*' -type f | sort)
}
