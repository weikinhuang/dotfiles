#!/usr/bin/env bats
# Tests for dotenv/aliases.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_test_bin

  export SHELL=/bin/bash
  dotfiles_hook_plugin_post_functions=()

  internal::find-editor() {
    echo "stub-editor"
  }

  cat >"${MOCK_BIN}/ls" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --color | --color=auto | --format=long)
    exit 0
    ;;
esac
exit 0
EOF
  chmod +x "${MOCK_BIN}/ls"

  cat >"${MOCK_BIN}/grep" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--color=auto" ]]; then
  exit 0
fi
exec /usr/bin/grep "$@"
EOF
  chmod +x "${MOCK_BIN}/grep"

  source "${REPO_ROOT}/dotenv/aliases.sh"
}

@test "aliases: defines navigation and editor aliases" {
  [[ "$(alias ..)" == "alias ..='cd ..'" ]]
  [[ "$(alias oo)" == "alias oo='open .'" ]]
  [[ "$(alias reload)" == "alias reload='exec /bin/bash -l'" ]]
  [[ "$(alias vi)" == "alias vi='stub-editor'" ]]
}

@test "aliases: registers and executes the post-plugin color hook" {
  [[ " ${dotfiles_hook_plugin_post_functions[*]} " == *" internal::grep-ls-colors "* ]]

  internal::grep-ls-colors

  [[ "$(alias ls)" == "alias ls='${MOCK_BIN}/ls --color=auto --hyperlink=auto'" ]]
  [[ "$(alias la)" == "alias la='${MOCK_BIN}/ls -lA --color=auto --hyperlink=auto'" ]]
  [[ "$(type -t internal::grep-ls-colors 2>/dev/null || true)" == "" ]]
}

@test "aliases: color hook falls back to BSD ls flags and skips unsupported color aliases" {
  stub_command ls <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --color | --color=auto | --format=long | --hyperlink*)
    exit 1
    ;;
esac
exit 0
EOF

  stub_command grep <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--color=auto" ]]; then
  exit 1
fi
exec /usr/bin/grep "$@"
EOF

  unalias ls grep fgrep egrep la ll l. dir vdir 2>/dev/null || true

  internal::grep-ls-colors

  [[ "$(alias ls)" == "alias ls='${MOCK_BIN}/ls -G'" ]]
  [[ "$(alias la)" == "alias la='${MOCK_BIN}/ls -lA -G'" ]]
  [[ -z "$(alias grep 2>/dev/null || true)" ]]
  [[ -z "$(alias dir 2>/dev/null || true)" ]]
  [[ -z "$(alias vdir 2>/dev/null || true)" ]]
}

@test "aliases: suppresses ls --hyperlink on WSL where the hostname cannot be resolved" {
  export DOT___IS_WSL=1

  internal::grep-ls-colors

  [[ "$(alias ls)" == "alias ls='${MOCK_BIN}/ls --color=auto'" ]]
  [[ "$(alias la)" == "alias la='${MOCK_BIN}/ls -lA --color=auto'" ]]
}

@test "aliases: enables tty-aware which expansion when which supports alias lookup" {
  run bash -c '
    internal::find-editor() { echo "stub-editor"; }
    dotfiles_hook_plugin_post_functions=()
    which() { return 0; }
    source "$1"
    alias which
  ' _ "${REPO_ROOT}/dotenv/aliases.sh"

  assert_success
  assert_output --partial "--tty-only --read-alias --show-dot --show-tilde"
}
