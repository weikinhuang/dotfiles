#!/usr/bin/env bats
# Tests for plugins/05-ls.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env

  cat >"${MOCK_BIN}/ls" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --color | --color=auto | --format=long | --hyperlink=auto)
    exit 0
    ;;
esac
exit 0
EOF
  chmod +x "${MOCK_BIN}/ls"
}

@test "05-ls: adds --hyperlink=auto to ls aliases" {
  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias ls)" == "alias ls='${MOCK_BIN}/ls --color=auto --hyperlink=auto'" ]]
  [[ "$(alias la)" == "alias la='${MOCK_BIN}/ls -lA --color=auto --hyperlink=auto'" ]]
  [[ "$(alias ll)" == "alias ll='${MOCK_BIN}/ls -l --color=auto --hyperlink=auto'" ]]
  [[ "$(alias l.)" == "alias l.='${MOCK_BIN}/ls -d --color=auto --hyperlink=auto .*'" ]]
}

@test "05-ls: redefines dir and vdir" {
  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias dir)" == "alias dir='${MOCK_BIN}/ls --color=auto --format=vertical'" ]]
  [[ "$(alias vdir)" == "alias vdir='${MOCK_BIN}/ls --color=auto --format=long'" ]]
}

@test "05-ls: uses osc8-wsl-rewrite wrapper on WSL" {
  export DOT___IS_WSL=1

  internal::osc8-wsl-rewrite() { :; }

  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias ls)" == "alias ls='internal::osc8-wsl-rewrite ${MOCK_BIN}/ls --color=auto --hyperlink=always'" ]]
  [[ "$(alias la)" == "alias la='internal::osc8-wsl-rewrite ${MOCK_BIN}/ls -lA --color=auto --hyperlink=always'" ]]
}

@test "05-ls: suppresses hyperlinks over SSH" {
  export DOT___IS_SSH=1

  alias ls="original-ls"

  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias ls)" == "alias ls='original-ls'" ]]
}

@test "05-ls: suppresses hyperlinks when DOT_DISABLE_HYPERLINKS is set" {
  export DOT_DISABLE_HYPERLINKS=1

  alias ls="original-ls"

  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias ls)" == "alias ls='original-ls'" ]]
}

@test "05-ls: skips when ls does not support --hyperlink" {
  stub_command ls <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --color | --color=auto | --format=long)
    exit 0
    ;;
  --hyperlink*)
    exit 1
    ;;
esac
exit 0
EOF

  alias ls="original-ls"

  source "${REPO_ROOT}/plugins/05-ls.sh"

  [[ "$(alias ls)" == "alias ls='original-ls'" ]]
}
