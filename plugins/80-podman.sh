# shellcheck shell=bash

# @see https://podman.io/
if ! command -v podman &>/dev/null; then
  return
fi

# fix for: WARN[0000] "/" is not a shared mount, this could cause issues or
# missing mounts with rootless containers.
# Keep privileged commands out of shell init; run this helper explicitly.
function podman-wsl2-fix-mount() {
  if [[ -z "${DOT___IS_WSL2:-}" ]]; then
    echo "podman-wsl2-fix-mount is only needed on WSL2" >&2
    return 1
  fi
  if grep ' / / ' /proc/1/mountinfo | grep -q 'shared:'; then
    return 0
  fi
  sudo mount --make-rshared /
}

__dot_cached_completion podman "podman completion bash"

# default build behavior to run as docker image spec
# https://docs.podman.io/en/latest/markdown/podman-build.1.html#format
export BUILDAH_FORMAT=docker

if ! command -v docker &>/dev/null; then
  # use podman as an proxy to docker if docker is not installed
  alias docker=podman
  alias docker-compose=podman-compose
  complete -o default -F __start_podman docker
else
  # use podman with fallback to docker if docker env vars are set or is running
  __podman_docker_autopath="$(
    unalias docker &>/dev/null
    command -v docker
  )"
  __podman_docker_compose_autopath="$(
    unalias docker-compose &>/dev/null
    command -v docker-compose
  )"
  export __podman_docker_autopath
  export __podman_docker_compose_autopath
  function docker() {
    if [[ -n "${DOCKER_HOST:-}" ]] || [[ -S /var/run/docker.sock ]]; then
      "${__podman_docker_autopath}" "$@"
    else
      podman "$@"
    fi
  }
  export -f docker

  function docker-compose() {
    if [[ -n "${DOCKER_HOST:-}" ]] || [[ -S /var/run/docker.sock ]]; then
      "${__podman_docker_compose_autopath}" "$@"
    else
      podman-compose "$@"
    fi
  }
  export -f docker-compose
fi
