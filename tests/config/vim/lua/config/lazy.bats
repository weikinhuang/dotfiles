#!/usr/bin/env bats
# Tests for config/vim/lua/config/lazy.lua.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export XDG_DATA_HOME="${HOME}/.local/share"
  export LAZY_GIT_LOG="${BATS_TEST_TMPDIR}/lazy-git.log"
  : >"${LAZY_GIT_LOG}"

  stub_command git <<'EOF'
#!/usr/bin/env bash
printf 'GIT_CONFIG_GLOBAL=%s\n' "${GIT_CONFIG_GLOBAL:-}" >>"${LAZY_GIT_LOG}"
printf 'GIT_CONFIG_NOSYSTEM=%s\n' "${GIT_CONFIG_NOSYSTEM:-}" >>"${LAZY_GIT_LOG}"
printf '%s\n' "$*" >>"${LAZY_GIT_LOG}"

if [[ "${1:-}" == "clone" ]]; then
  target="${@: -1}"
  mkdir -p "${target}/lua/lazy/manage"
  cat >"${target}/lua/lazy/init.lua" <<'LAZY_EOF'
local M = {}

function M.setup()
end

return M
LAZY_EOF
  cat >"${target}/lua/lazy/manage/process.lua" <<'LAZY_EOF'
return {
  spawn = function(cmd, opts)
    return cmd, opts
  end,
}
LAZY_EOF
fi
EOF
}

@test "lazy.lua: bootstraps lazy.nvim with sanitized git config and tag-aware clone" {
  mkdir -p "${XDG_CONFIG_HOME}/nvim"
  ln -s "${REPO_ROOT}/config/vim/nvim-init.lua" "${XDG_CONFIG_HOME}/nvim/init.lua"

  cat >"${HOME}/.gitconfig" <<EOF
[include]
  path = ${REPO_ROOT}/config/git/overrides.gitconfig.conf
EOF

  run env \
    HOME="${HOME}" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
    XDG_DATA_HOME="${XDG_DATA_HOME}" \
    PATH="${MOCK_BIN}:${PATH}" \
    nvim --headless +qa

  assert_success
  [ -f "${XDG_DATA_HOME}/nvim/lazy/lazy.nvim/lua/lazy/init.lua" ]

  run cat "${LAZY_GIT_LOG}"
  assert_success
  assert_output --partial "GIT_CONFIG_GLOBAL=/dev/null"
  assert_output --partial "GIT_CONFIG_NOSYSTEM=1"
  assert_output --partial "clone --filter=blob:none --branch=stable"
  [[ "${output}" != *"--no-tags"* ]]
}
