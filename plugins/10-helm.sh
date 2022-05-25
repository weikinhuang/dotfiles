# shellcheck shell=bash

# @see https://helm.sh/
if command -v helm &>/dev/null; then
  # autocomplete for helm
  # shellcheck source=/dev/null
  source <(helm completion bash 2>/dev/null)
fi
