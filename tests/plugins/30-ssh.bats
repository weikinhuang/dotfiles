#!/usr/bin/env bats
# Tests for plugins/30-ssh.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  export TEST_SSH_LOG="${BATS_TEST_TMPDIR}/ssh.log"
  : >"${TEST_SSH_LOG}"
}

@test "30-ssh: autoloads ssh-agent when no working socket exists" {
  export DOT_AUTOLOAD_SSH_AGENT=1
  stub_fixed_output_command ssh ""
  stub_command ssh-agent <<'EOF'
#!/usr/bin/env bash
printf 'agent\n' >>"${TEST_SSH_LOG}"
printf 'SSH_AUTH_SOCK=%s; export SSH_AUTH_SOCK\n' "${HOME}/.ssh/agent.sock"
printf 'SSH_AGENT_PID=1234; export SSH_AGENT_PID\n'
EOF
  stub_command ssh-add <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-l" ]]; then
  exit 2
fi
printf 'add\n' >>"${TEST_SSH_LOG}"
EOF

  source "${REPO_ROOT}/plugins/30-ssh.sh"

  [ "${SSH_AUTH_SOCK}" = "${HOME}/.ssh/agent.sock" ]
  [ -f "${HOME}/.ssh/agent.env" ]
  [ "$(cat "${TEST_SSH_LOG}")" = $'agent\nadd' ]
  [ -z "${DOT_AUTOLOAD_SSH_AGENT+x}" ]
  [ "$(type -t internal::ssh-agent-start || true)" = "" ]
}

@test "30-ssh: caches completion candidates from ssh config and known_hosts" {
  stub_fixed_output_command ssh ""
  mkdir -p "${HOME}/.ssh/config.d"
  cat >"${HOME}/.ssh/config" <<'EOF'
Host web app
Host *.wild
Host skipme no-complete
EOF
  cat >"${HOME}/.ssh/config.d/extra" <<'EOF'
Host db
Host web
EOF
  cat >"${HOME}/.ssh/known_hosts" <<'EOF'
example.com ssh-ed25519 AAAA
[api.example.com]:2222 ssh-ed25519 BBBB
|1|hashed hashed
EOF

  source "${REPO_ROOT}/plugins/30-ssh.sh"

  run cat "${DOTFILES__CONFIG_DIR}/cache/completions/ssh_hosts.list"
  assert_success
  assert_output $'api.example.com\napp\ndb\nexample.com\nweb'
  [[ "$(complete -p ssh)" == *"api.example.com app db example.com web "* ]]
  [ -z "${_ssh_cache_file+x}" ]
  [ -z "${_ssh_host_words+x}" ]
  [ "$(type -t internal::ssh-completion-needs-refresh || true)" = "" ]
  [ "$(type -t internal::ssh-configure-completion || true)" = "" ]
}
