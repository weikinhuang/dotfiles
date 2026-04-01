#!/usr/bin/env bats
# Tests for bashrc.sh.
# SPDX-License-Identifier: MIT

write_fixture_file() {
  local path="$1"
  mkdir -p "$(dirname "${path}")"
  cat >"${path}"
}

create_bashrc_fixture() {
  local install_root="$1"

  write_fixture_file "${install_root}/.dotfiles/dotenv/lib/utils.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}utils"
PROMPT_COMMANDS=()
INTERNAL_PROMPT_COMMANDS=()

internal::prompt-command-push() {
  PROMPT_COMMANDS+=("$1")
}

internal::prompt-action-push() {
  INTERNAL_PROMPT_COMMANDS+=("$1")
}
EOF

  write_fixture_file "${install_root}/.dotfiles/dotenv/lib/path.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}path"

internal::path-setup() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}path-setup"
}

internal::path-cleanup() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}path-clean"
}
EOF

  write_fixture_file "${install_root}/.dotfiles/dotenv/lib/load.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}load-lib"

internal::load-phase() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}load-$1"
}

internal::load-plugins() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}load-plugin"
}

internal::load-cleanup() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}load-clean"
  unset -f internal::load-phase
  unset -f internal::load-plugins
  unset -f internal::load-cleanup
}
EOF

  write_fixture_file "${install_root}/.dotfiles/external/bash-preexec.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}preexec"
EOF
}

setup() {
  load './helpers/common'
  setup_test_bin
  setup_isolated_home
}

@test "bashrc: noninteractive shells return before initialization" {
  run bash --noprofile --norc -c '
    export HOME="$2"
    export XDG_CONFIG_HOME="${HOME}/.config"
    mkdir -p "${HOME}"
    unset PS1
    unset BASHRC_NONINTERACTIVE_BYPASS

    source "$1"

    printf "dotroot=%s\n" "${DOTFILES__ROOT-unset}"
    if [[ -d "${XDG_CONFIG_HOME}/dotfiles/cache" ]]; then
      echo "cache=present"
    else
      echo "cache=absent"
    fi
  ' _ "${REPO_ROOT}/bashrc.sh" "${HOME}"

  assert_success
  assert_line --index 0 "dotroot=unset"
  assert_line --index 1 "cache=absent"
}

@test "bashrc: initializes install root, environment detection, hooks, and cleanup" {
  local install_root="${BATS_TEST_TMPDIR}/install-root"
  create_bashrc_fixture "${install_root}"

  mkdir -p "${XDG_CONFIG_HOME}/dotfiles"
  cat >"${XDG_CONFIG_HOME}/dotfiles/.install" <<EOF
DOTFILES__INSTALL_ROOT="${install_root}"
EOF
  cat >"${HOME}/.bash_local" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}bash-local"
dotfiles_complete() {
  DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}dotfiles-complete"
}
EOF
  mkdir -p "${HOME}/.bash_local.d" "${HOME}/.config/completion.d"
  cat >"${HOME}/.bash_local.d/10-local.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}bash-local-d"
EOF
  cat >"${HOME}/.config/completion.d/test.sh" <<'EOF'
DOT_TRACE="${DOT_TRACE:+${DOT_TRACE}:}completion-d"
EOF

  stub_command uname <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s)
    printf 'Linux\n'
    ;;
  -r)
    printf '5.15.167.4-microsoft-standard-WSL2\n'
    ;;
esac
EOF
  stub_fixed_output_command wslpath ""

  run bash --noprofile --norc -c '
    export HOME="$2"
    export XDG_CONFIG_HOME="${HOME}/.config"
    export PATH="$3:${PATH}"
    export PS1="$ "
    export TERM="screen"
    export SSH_CONNECTION="client server"

    source "$1"

    printf "dotenv=%s\n" "${DOTENV}"
    printf "wsl=%s\n" "${DOT___IS_WSL:-}"
    printf "wsl2=%s\n" "${DOT___IS_WSL2:-}"
    printf "screen=%s\n" "${DOT___IS_SCREEN:-}"
    printf "ssh=%s\n" "${DOT___IS_SSH:-}"
    printf "term=%s\n" "${TERM}"
    printf "root=%s\n" "${DOTFILES__ROOT}"
    printf "config=%s\n" "${DOTFILES__CONFIG_DIR}"
    printf "trace=%s\n" "${DOT_TRACE}"
    printf "prompt=%s\n" "${PROMPT_COMMANDS[*]}"
    printf "internal=%s\n" "${INTERNAL_PROMPT_COMMANDS[*]}"
    printf "load-type=%s\n" "$(type -t internal::load-phase || true)"
    printf "complete-type=%s\n" "$(type -t dotfiles_complete || true)"
    if [[ -d "${DOTFILES__CONFIG_DIR}/cache/completions" ]]; then
      echo "cache-dirs=present"
    else
      echo "cache-dirs=missing"
    fi
  ' _ "${REPO_ROOT}/bashrc.sh" "${HOME}" "${MOCK_BIN}"

  assert_success
  assert_line --index 0 "dotenv=linux"
  assert_line --index 1 "wsl=1"
  assert_line --index 2 "wsl2=1"
  assert_line --index 3 "screen=1"
  assert_line --index 4 "ssh=1"
  assert_line --index 5 "term=screen-256color"
  assert_line --index 6 "root=${install_root}"
  assert_line --index 7 "config=${XDG_CONFIG_HOME}/dotfiles"
  assert_line --index 8 "trace=utils:path:path-setup:bash-local:bash-local-d:load-lib:load-exports:load-functions:load-aliases:load-extra:load-env:load-completion:completion-d:load-plugin:load-prompt:path-clean:load-clean:preexec:dotfiles-complete"
  assert_line --index 9 "prompt=internal::prompt-action-run"
  assert_line --index 10 "internal=history -a"
  assert_line --index 11 "load-type="
  assert_line --index 12 "complete-type="
  assert_line --index 13 "cache-dirs=missing"
}

@test "bashrc: creates the dotfiles config dir without eagerly creating cache dirs" {
  create_bashrc_fixture "${HOME}"

  run bash --noprofile --norc -c '
    export HOME="$2"
    export XDG_CONFIG_HOME="${HOME}/.config"
    export PS1="$ "

    source "$1"

    if [[ -d "${DOTFILES__CONFIG_DIR}" ]]; then
      echo "config-dir=present"
    else
      echo "config-dir=missing"
    fi
    if [[ -d "${DOTFILES__CONFIG_DIR}/cache" ]]; then
      echo "cache-dir=present"
    else
      echo "cache-dir=missing"
    fi
  ' _ "${REPO_ROOT}/bashrc.sh" "${HOME}"

  assert_success
  assert_line --index 0 "config-dir=present"
  assert_line --index 1 "cache-dir=missing"
}
