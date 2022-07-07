# shellcheck shell=bash

# @see https://kubernetes.io/
if ! command -v kubectl &>/dev/null; then
  return
fi

# If the completion file does not exist, generate it and then source it
# Otherwise, source it and regenerate in the background
if [[ ! -f "${DOTFILES__CONFIG_DIR}/cache/completions/kubectl.bash" ]]; then
  kubectl completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/kubectl.bash" >/dev/null
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/kubectl.bash"
else
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/kubectl.bash"
  (kubectl completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/kubectl.bash" >/dev/null) &
fi

# create alias
alias kc=kubectl
complete -o default -F __start_kubectl kc

# install completion for kind
if command -v kind &>/dev/null; then
  # If the completion file does not exist, generate it and then source it
  # Otherwise, source it and regenerate in the background
  if [[ ! -f "${DOTFILES__CONFIG_DIR}/cache/completions/kind.bash" ]]; then
    kind completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/kind.bash" >/dev/null
    # shellcheck source=/dev/null
    source "${DOTFILES__CONFIG_DIR}/cache/completions/kind.bash"
  else
    # shellcheck source=/dev/null
    source "${DOTFILES__CONFIG_DIR}/cache/completions/kind.bash"
    (kind completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/kind.bash" >/dev/null) &
  fi
fi
