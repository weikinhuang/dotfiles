# shellcheck shell=bash

# @see https://helm.sh/
if ! command -v helm &>/dev/null; then
  return
fi

# If the completion file does not exist, generate it and then source it
# Otherwise, source it and regenerate in the background
if [[ ! -f "${DOTFILES__CONFIG_DIR}/cache/completions/helm.bash" ]]; then
  helm completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/helm.bash" >/dev/null
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/helm.bash"
else
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/helm.bash"
  (helm completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/helm.bash" >/dev/null) &
fi
