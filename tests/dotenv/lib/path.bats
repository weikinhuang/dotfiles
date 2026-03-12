#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export DOTFILES__ROOT="${BATS_TEST_TMPDIR}/root"
  export DOTENV=linux
  mkdir -p "${DOTFILES__ROOT}/.dotfiles/dotenv"

  source "${REPO_ROOT}/dotenv/lib/path.sh"
}

@test "path: push-path appends an existing directory only once" {
  local tools_dir="${BATS_TEST_TMPDIR}/tools"
  mkdir -p "${tools_dir}"
  PATH="/usr/bin:/bin"

  __push_path "${tools_dir}/"
  __push_path "${tools_dir}"

  [ "${PATH}" = "/usr/bin:/bin:${tools_dir}" ]
}

@test "path: push-path prepends when requested" {
  local tools_dir="${BATS_TEST_TMPDIR}/tools"
  mkdir -p "${tools_dir}"
  PATH="/usr/bin:/bin"

  __push_path --prepend "${tools_dir}"

  [ "${PATH}" = "${tools_dir}:/usr/bin:/bin" ]
}

@test "path: dedup-path removes duplicates and normalizes trailing slashes" {
  local tools_dir="${BATS_TEST_TMPDIR}/tools"
  mkdir -p "${tools_dir}"
  PATH="/usr/bin:${tools_dir}/:${tools_dir}:/bin:/usr/bin/"

  __dedup_path

  [ "${PATH}" = "/usr/bin:${tools_dir}:/bin" ]
}

@test "path: dot-path-setup adds expected platform and user bin directories" {
  local arch
  arch="$(uname -m)"
  local python_base="${BATS_TEST_TMPDIR}/python"
  mkdir -p \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/linux/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/linux/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/bin" \
    "${HOME}/bin" \
    "${python_base}/bin"

  stub_command python3 <<EOF
#!/usr/bin/env bash
echo "${python_base}"
EOF

  export TMUX=1
  export DOT___IS_SSH=1
  export DOT___IS_WSL=1
  export DOT___IS_WSL2=1
  PATH="${MOCK_BIN}:/usr/bin:/bin"

  __dot_path_setup

  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${arch}"* ]]
  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${arch}"* ]]
  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"* ]]
  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"* ]]
  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/linux/bin"* ]]
  [[ "${PATH}" == *"${DOTFILES__ROOT}/.dotfiles/dotenv/bin"* ]]
  [[ "${PATH}" == *"${HOME}/bin"* ]]
  [[ "${PATH}" == *"${python_base}/bin"* ]]
}

@test "path: dot-path-setup prepends higher-priority tmux, screen, and ssh bins" {
  local arch
  arch="$(uname -m)"
  mkdir -p \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${arch}" \
    "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"

  export TMUX=1
  export DOT___IS_SCREEN=1
  export DOT___IS_SSH=1
  PATH="/usr/bin:/bin"

  __dot_path_setup

  [[ "${PATH}" == "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${arch}:${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin:${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.${arch}:${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin:${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${arch}:${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin:/usr/bin:/bin" ]]
}

@test "path: dot-path-cleanup deduplicates PATH and removes setup helpers" {
  local tools_dir="${BATS_TEST_TMPDIR}/tools"
  mkdir -p "${tools_dir}"
  PATH="/usr/bin:${tools_dir}/:${tools_dir}:/bin"

  __dot_path_cleanup

  [ "${PATH}" = "/usr/bin:${tools_dir}:/bin" ]
  [ "$(type -t __dot_path_setup || true)" = "" ]
  [ "$(type -t __dot_path_cleanup || true)" = "" ]
}
