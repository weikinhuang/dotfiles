# shellcheck shell=bash

# @see https://podman.io/
if ! command -v podman &>/dev/null; then
  return
fi

# fix for: WARN[0000] "/" is not a shared mount, this could cause issues or missing mounts with rootless containers
if [[ -n "${DOT___IS_WSL2}" ]] && ! (grep ' / / ' /proc/1/mountinfo | grep -q 'shared:'); then
  # please add this to sudoers
  sudo mount --make-rshared / &>/dev/null || true
fi

# If the completion file does not exist, generate it and then source it
# Otherwise, source it and regenerate in the background
if [[ ! -f "${DOTFILES__CONFIG_DIR}/cache/completions/podman.bash" ]]; then
  podman completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/podman.bash" >/dev/null
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/podman.bash"
else
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/podman.bash"
  (podman completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/podman.bash" >/dev/null &)
fi

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
    unset -f docker &>/dev/null
    command -v docker
  )"
  __podman_docker_compose_autopath="$(
    unset -f docker-compose &>/dev/null
    command -v docker-compose
  )"
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
