#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env

  __start_podman() {
    :
  }
}

@test "80-podman: aliases docker to podman when docker is unavailable" {
  stub_named_passthrough_command podman
  stub_named_passthrough_command podman-compose

  source "${REPO_ROOT}/plugins/80-podman.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "podman|podman completion bash" ]
  [ "${BUILDAH_FORMAT}" = "docker" ]
  [ "$(alias docker)" = "alias docker='podman'" ]
  [ "$(alias docker-compose)" = "alias docker-compose='podman-compose'" ]
  [[ "$(complete -p docker)" == *"__start_podman docker"* ]]
}

@test "80-podman: docker wrappers fall back to podman unless docker is explicitly active" {
  stub_named_passthrough_command podman
  stub_named_passthrough_command podman-compose
  stub_named_passthrough_command docker
  stub_named_passthrough_command docker-compose

  source "${REPO_ROOT}/plugins/80-podman.sh"

  run docker ps
  assert_success
  assert_output $'podman\nps'

  run docker-compose up
  assert_success
  assert_output $'podman-compose\nup'

  export DOCKER_HOST=tcp://127.0.0.1:2375
  run docker ps
  assert_success
  assert_output $'docker\nps'

  run docker-compose up
  assert_success
  assert_output $'docker-compose\nup'
}
