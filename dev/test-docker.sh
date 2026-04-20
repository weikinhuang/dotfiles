#!/usr/bin/env bash
# Run the Bats test suite inside a Docker container.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="dotfiles-test"
DOCKERFILE="${REPO_ROOT}/dev/Dockerfile.test"

BUILD_FLAGS=(-q -t "${IMAGE_NAME}")
TEST_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cache)
      BUILD_FLAGS+=(--no-cache)
      ;;
    --pull)
      BUILD_FLAGS+=(--pull)
      ;;
    -h | --help)
      cat <<'EOF'
Usage: dev/test-docker.sh [--no-cache] [--pull] [TEST_ARGS...]

Runs the Bats suite in the dotfiles-test container. Any unrecognized
arguments are forwarded to dev/test.sh inside the container.

Options:
  --no-cache    build the image with --no-cache
  --pull        re-fetch the pinned base image before building
  -h, --help    display this help and exit
EOF
      exit 0
      ;;
    *)
      TEST_ARGS+=("$1")
      ;;
  esac
  shift
done

if ! command -v docker &>/dev/null; then
  echo "error: docker is not installed" >&2
  exit 1
fi

# Send only the Dockerfile as context (via stdin) since it only installs apt
# packages and the repo is bind-mounted at runtime.
docker build "${BUILD_FLAGS[@]}" - <"${DOCKERFILE}"

exec docker run --rm \
  -v "${REPO_ROOT}:/dotfiles:ro" \
  "${IMAGE_NAME}" \
  bash /dotfiles/dev/test.sh "${TEST_ARGS[@]}"
