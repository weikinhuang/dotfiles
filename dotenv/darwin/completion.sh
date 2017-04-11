# Completion options
if type brew &>/dev/null && [[ -f $(brew --prefix)/etc/bash_completion ]]; then
  source $(brew --prefix)/etc/bash_completion
fi
