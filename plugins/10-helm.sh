# shellcheck shell=bash

# @see https://helm.sh/
if ! command -v helm &>/dev/null; then
  return
fi

__dot_cached_completion helm "helm completion bash" "helm version"
