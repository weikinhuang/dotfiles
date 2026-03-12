#!/usr/bin/env bash
#title              : test-docker.sh
#description        : Run the bats test suite inside a Docker container
#usage              : ./dev/test-docker.sh [bats options] [test file or dir...]
#requires           : docker
#===============================================================================
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="dotfiles-test"

if ! command -v docker &>/dev/null; then
  echo "error: docker is not installed" >&2
  exit 1
fi

# Send only the Dockerfile as context (via stdin) since it only installs apt
# packages and the repo is bind-mounted at runtime. This avoids sending the
# full repo on every build and prevents unnecessary cache invalidation.
docker build -q -t "${IMAGE_NAME}" - <"${REPO_ROOT}/dev/Dockerfile.test"

exec docker run --rm \
  -v "${REPO_ROOT}:/dotfiles:ro" \
  "${IMAGE_NAME}" \
  bash /dotfiles/dev/test.sh "$@"
