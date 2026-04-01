# shellcheck shell=bash
# Configure kubectl completion.
# SPDX-License-Identifier: MIT

# @see https://kubernetes.io/
if ! command -v kubectl &>/dev/null; then
  return
fi

# Lazy-load kubectl completion: only parse the ~330KB script on first tab-completion.
function internal::kubectl-lazy-complete() {
  unset -f internal::kubectl-lazy-complete
  internal::cached-completion kubectl "kubectl completion bash"
  complete -o default -F __start_kubectl kc
  __start_kubectl "$@"
}

# create alias
alias kc=kubectl
complete -F internal::kubectl-lazy-complete kubectl kc

# install completion for kind
if command -v kind &>/dev/null; then
  internal::cached-completion kind "kind completion bash"
fi
