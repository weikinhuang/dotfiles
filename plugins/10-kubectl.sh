# shellcheck shell=bash

# @see https://kubernetes.io/
if command -v kubectl &>/dev/null; then
  # autocomplete for kubectl
  # shellcheck source=/dev/null
  source <(kubectl completion bash 2>/dev/null)

  # create alias
  alias kc=kubectl
  complete -o default -F __start_kubectl kc
fi
