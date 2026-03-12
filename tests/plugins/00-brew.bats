#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "00-brew: skips non-darwin shells and clears the include flag" {
  export DOTENV=linux
  export DOT_INCLUDE_BREW_PATH=1
  local original_path="${PATH}"

  source "${REPO_ROOT}/plugins/00-brew.sh"

  [ "${PATH}" = "${original_path}" ]
  [ -z "${DOT_INCLUDE_BREW_PATH+x}" ]
}

@test "00-brew: prepends brew paths, caches GNU shims, and sources bash completion" {
  local prefix="${BATS_TEST_TMPDIR}/brew"
  local cache_key="${prefix//\//_}"
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/brew_gnu_paths.${cache_key}.cache"

  export DOTENV=darwin
  export DOT_INCLUDE_BREW_PATH=1
  prepend_path "${prefix}/bin"

  write_executable "${prefix}/bin/brew" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  write_executable "${prefix}/share/bash-completion/bash_completion" <<'EOF'
BREW_COMPLETION_LOADED=1
EOF
  mkdir -p \
    "${prefix}/share/man" \
    "${prefix}/Cellar/coreutils/9.5/libexec/gnubin" \
    "${prefix}/Cellar/coreutils/9.5/libexec/gnuman"

  source "${REPO_ROOT}/plugins/00-brew.sh"

  [ "${BREW_COMPLETION_LOADED}" = "1" ]
  [[ ":${PATH}:" == *":${prefix}/bin:"* ]]
  [[ ":${PATH}:" == *":${prefix}/sbin:"* ]]
  [[ ":${PATH}:" == *":${prefix}/opt:"* ]]
  [[ ":${PATH}:" == *":${prefix}/Cellar/coreutils/9.5/libexec/gnubin:"* ]]
  [[ "${MANPATH}" == "${prefix}/Cellar/coreutils/9.5/libexec/gnuman:"* ]]
  [[ "${MANPATH}" == *":${prefix}/share/man:"* ]] || [[ "${MANPATH}" == "${prefix}/share/man:"* ]]
  [ -f "${cache_file}" ]
  grep -Fx "PATH:${prefix}/Cellar/coreutils/9.5/libexec/gnubin" "${cache_file}"
  grep -Fx "MAN:${prefix}/Cellar/coreutils/9.5/libexec/gnuman" "${cache_file}"
  [ -z "${DOT_INCLUDE_BREW_PATH+x}" ]
  [ -z "${__BREW_PREFIX+x}" ]
}
