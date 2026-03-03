# shellcheck shell=bash

# @see https://kubernetes.io/
if ! command -v kubectl &>/dev/null; then
  return
fi

__dot_cached_completion kubectl "kubectl completion bash"

# create alias
alias kc=kubectl
complete -o default -F __start_kubectl kc

# install completion for kind
if command -v kind &>/dev/null; then
  __dot_cached_completion kind "kind completion bash"
fi
