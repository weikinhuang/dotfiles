#!/usr/bin/env bats

create_mock_nvm_install() {
  local base_dir="$1"
  local default_version="${2:-v18.17.0}"
  mkdir -p "${base_dir}/versions/node/${default_version}/bin"

  cat >"${base_dir}/nvm.sh" <<'EOF'
nvm() {
  case "${1:-}" in
    version)
      case "${2:-}" in
        default)
          printf '%s\n' "${TEST_NVM_DEFAULT_VERSION:-v18.17.0}"
          ;;
        "${TEST_NVM_PROJECT_VERSION:-}")
          printf '%s\n' "${TEST_NVM_PROJECT_RESOLVED_VERSION:-N/A}"
          ;;
        *)
          printf '%s\n' "${2:-}"
          ;;
      esac
      ;;
    use)
      printf 'use:%s\n' "${2:-}" >>"${TEST_NVM_LOG}"
      ;;
    install)
      printf 'install:%s\n' "${2:-}" >>"${TEST_NVM_LOG}"
      TEST_NVM_PROJECT_RESOLVED_VERSION="${TEST_NVM_PROJECT_INSTALLED_VERSION:-v20.11.1}"
      export TEST_NVM_PROJECT_RESOLVED_VERSION
      ;;
    alias)
      printf 'alias:%s:%s\n' "${2:-}" "${3:-}" >>"${TEST_NVM_LOG}"
      ;;
  esac
}

node() {
  printf 'node:%s\n' "$*" >>"${TEST_NVM_LOG}"
}

npm() {
  printf 'npm:%s\n' "$*" >>"${TEST_NVM_LOG}"
}

npx() {
  printf 'npx:%s\n' "$*" >>"${TEST_NVM_LOG}"
}

nvm_find_up() {
  printf '%s\n' "${TEST_NVM_FIND_UP:-}"
}
EOF

  cat >"${base_dir}/bash_completion" <<'EOF'
NVM_BASH_COMPLETION_LOADED=1
EOF
}

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  export TEST_NVM_LOG="${BATS_TEST_TMPDIR}/nvm.log"
  : >"${TEST_NVM_LOG}"
}

@test "20-nvm: returns early when nvm is unavailable" {
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/20-nvm.sh"

  [ -z "${NVM_DIR+x}" ]
  [ -z "$(type -t cdnvm || true)" ]
}

@test "20-nvm: seeds the default-node cache from nvm.sh when no cache exists" {
  export TEST_NVM_DEFAULT_VERSION="v18.17.0"
  create_mock_nvm_install "${XDG_CONFIG_HOME}/nvm" "${TEST_NVM_DEFAULT_VERSION}"

  source "${REPO_ROOT}/plugins/20-nvm.sh"

  [ "${NVM_DIR}" = "${XDG_CONFIG_HOME}/nvm" ]
  [ -z "${NPM_CONFIG_PREFIX+x}" ]
  [ "${NVM_BASH_COMPLETION_LOADED}" = "1" ]
  [[ ":${PATH}:" == *":${NVM_DIR}/versions/node/${TEST_NVM_DEFAULT_VERSION}/bin:"* ]]
  [ "$(cat "${DOTFILES__CONFIG_DIR}/cache/nvm_default_path")" = "${NVM_DIR}/versions/node/${TEST_NVM_DEFAULT_VERSION}/bin" ]
  [[ " ${chpwd_functions[*]} " == *" cdnvm "* ]]
}

@test "20-nvm: uses the cached path and lazy-loads node commands on first use" {
  local cached_version="v20.8.1"
  local cached_path="${XDG_CONFIG_HOME}/nvm/versions/node/${cached_version}/bin"

  create_mock_nvm_install "${XDG_CONFIG_HOME}/nvm" "${cached_version}"
  mkdir -p "${DOTFILES__CONFIG_DIR}/cache"
  printf '%s\n' "${cached_path}" >"${DOTFILES__CONFIG_DIR}/cache/nvm_default_path"

  source "${REPO_ROOT}/plugins/20-nvm.sh"

  [ "$(type -t nvm)" = "function" ]
  [ "$(type -t node)" = "function" ]
  [ "$(type -t __nvm_lazy_load)" = "function" ]
  [[ ":${PATH}:" == *":${cached_path}:"* ]]

  node hello world >/dev/null

  grep -Fx "node:hello world" "${TEST_NVM_LOG}"
  [ -z "$(type -t __nvm_lazy_load || true)" ]
}

@test "20-nvm: cdnvm installs unresolved project versions from .nvmrc" {
  local project="${BATS_TEST_TMPDIR}/project"

  export TEST_NVM_PROJECT_VERSION="lts/*"
  export TEST_NVM_PROJECT_RESOLVED_VERSION="N/A"
  export TEST_NVM_PROJECT_INSTALLED_VERSION="v20.11.1"
  export TEST_NVM_FIND_UP="${project}"
  create_mock_nvm_install "${XDG_CONFIG_HOME}/nvm"

  mkdir -p "${project}"
  printf 'lts/*\n' >"${project}/.nvmrc"

  source "${REPO_ROOT}/plugins/20-nvm.sh"
  cd "${project}"
  cdnvm

  [ "$(cat "${TEST_NVM_LOG}")" = "install:lts/*" ]
  [ "${__cdnvm_last_scope}" = "${project}:lts/*" ]
  [ "${__cdnvm_last_resolved}" = "v20.11.1" ]
}
