#!/usr/bin/env bats
# Tests for bootstrap.sh.
# SPDX-License-Identifier: MIT

create_bootstrap_template_repo() {
  export BOOTSTRAP_TEMPLATE_REPO="${BATS_TEST_TMPDIR}/template-repo"
  mkdir -p "${BOOTSTRAP_TEMPLATE_REPO}/config/vim/ftplugin"

  printf 'profile\n' >"${BOOTSTRAP_TEMPLATE_REPO}/bash_profile.sh"
  printf 'rc\n' >"${BOOTSTRAP_TEMPLATE_REPO}/bashrc.sh"
  printf 'curl\n' >"${BOOTSTRAP_TEMPLATE_REPO}/curlrc"
  printf 'quiet\n' >"${BOOTSTRAP_TEMPLATE_REPO}/hushlogin"
  printf 'input\n' >"${BOOTSTRAP_TEMPLATE_REPO}/inputrc"
  printf 'mongo\n' >"${BOOTSTRAP_TEMPLATE_REPO}/mongorc.js"
  printf 'screen\n' >"${BOOTSTRAP_TEMPLATE_REPO}/screenrc"
  printf 'tmux\n' >"${BOOTSTRAP_TEMPLATE_REPO}/tmux.conf"
  printf 'wget\n' >"${BOOTSTRAP_TEMPLATE_REPO}/wgetrc"
  printf 'gitconfig\n' >"${BOOTSTRAP_TEMPLATE_REPO}/gitconfig"
  printf 'vimrc\n' >"${BOOTSTRAP_TEMPLATE_REPO}/vimrc"
  printf 'setlocal shiftwidth=2\n' >"${BOOTSTRAP_TEMPLATE_REPO}/config/vim/ftplugin/test.vim"
  printf '{"ts":"ok"}\n' >"${BOOTSTRAP_TEMPLATE_REPO}/config/vim/coc-settings.json"
}

stub_bootstrap_git() {
  stub_command git <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BOOTSTRAP_GIT_LOG}"

if [[ "${1:-}" == "clone" ]]; then
  mkdir -p "${3}"
  cp -R "${BOOTSTRAP_TEMPLATE_REPO}/." "${3}"
  exit 0
fi

if [[ "${1:-}" == "-C" ]]; then
  shift 2
  case "${1:-}" in
    diff-index)
      [[ -n "${BOOTSTRAP_GIT_DIRTY:-}" ]] && exit 1
      exit 0
      ;;
    pull)
      exit 0
      ;;
    stash)
      exit 0
      ;;
  esac
fi

exit 0
EOF
}

stub_bootstrap_editor() {
  stub_command nvim <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BOOTSTRAP_VIM_LOG}"
EOF
  stub_command vim <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BOOTSTRAP_VIM_LOG}"
EOF
}

setup() {
  load './helpers/common'
  setup_test_bin
  setup_isolated_home

  export BOOTSTRAP_GIT_LOG="${BATS_TEST_TMPDIR}/git.log"
  export BOOTSTRAP_VIM_LOG="${BATS_TEST_TMPDIR}/vim.log"
  : >"${BOOTSTRAP_GIT_LOG}"
  : >"${BOOTSTRAP_VIM_LOG}"
}

@test "bootstrap: missing --dir value fails fast" {
  run env HOME="${HOME}" bash "${REPO_ROOT}/bootstrap.sh" --dir

  assert_failure
  assert_output --partial "Missing value for --dir"
}

@test "bootstrap: fresh installs clone the repo, back up existing files, and link targets" {
  local install_root="${BATS_TEST_TMPDIR}/install"
  create_bootstrap_template_repo
  stub_bootstrap_git
  stub_bootstrap_editor

  mkdir -p "${install_root}"
  printf 'old bashrc\n' >"${install_root}/.bashrc"
  printf 'stale backup\n' >"${install_root}/.bashrc.bak"

  run env HOME="${HOME}" PATH="${MOCK_BIN}:${PATH}" bash "${REPO_ROOT}/bootstrap.sh" --dir "${install_root}"

  assert_success
  assert_output --partial "Dotfiles has been installed/updated"
  [ -L "${install_root}/.bashrc" ]
  [ "$(readlink "${install_root}/.bashrc")" = "${install_root}/.dotfiles/bashrc.sh" ]
  [ "$(cat "${install_root}/.bashrc.bak")" = "old bashrc" ]
  [ -L "${install_root}/.gitconfig" ]
  [ "$(readlink "${install_root}/.gitconfig")" = "${install_root}/.dotfiles/gitconfig" ]
  [ -L "${install_root}/.vimrc" ]
  [ "$(cat "${HOME}/.config/dotfiles/.install")" = $'DOTFILES__INSTALL_ROOT="'"${install_root}"$'"\nDOTFILES__INSTALL_VIMRC=1\nDOTFILES__INSTALL_GITCONFIG=1' ]
  grep -Fx "clone https://github.com/weikinhuang/dotfiles ${install_root}/.dotfiles" "${BOOTSTRAP_GIT_LOG}"
  grep -F -- "-Es -u ${install_root}/.vimrc +PlugInstall +qall" "${BOOTSTRAP_VIM_LOG}"
}

@test "bootstrap: updates dirty repos by stashing before pull and restoring after" {
  local install_root="${BATS_TEST_TMPDIR}/install"
  create_bootstrap_template_repo
  stub_bootstrap_git
  stub_bootstrap_editor

  export BOOTSTRAP_GIT_DIRTY=1
  mkdir -p "${install_root}"
  cp -R "${BOOTSTRAP_TEMPLATE_REPO}" "${install_root}/.dotfiles"

  run env HOME="${HOME}" PATH="${MOCK_BIN}:${PATH}" bash "${REPO_ROOT}/bootstrap.sh" --dir "${install_root}"

  assert_success
  run cat "${BOOTSTRAP_GIT_LOG}"
  assert_success
  assert_line --index 0 "-C ${install_root}/.dotfiles diff-index --quiet HEAD --"
  assert_line --index 1 "-C ${install_root}/.dotfiles stash"
  assert_line --index 2 "-C ${install_root}/.dotfiles pull origin master"
  assert_line --index 3 "-C ${install_root}/.dotfiles stash pop"
  [ -L "${install_root}/.bashrc" ]
}
