# SSH auto-completion based on entries in known_hosts.
if [[ -e "${HOME}/.ssh/config" ]] || [[ -d "${HOME}/.ssh/config.d/" ]]; then
  complete -o default -W "$(grep '^Host ' ${HOME}/.ssh/config ${HOME}/.ssh/config.d/* 2>/dev/null | grep -v '[?*]' | cut -d ' ' -f 2-  | sort | uniq)" ssh
elif [[ -e "${HOME}/.ssh/known_hosts" ]]; then
  complete -o default -W "$(cat "${HOME}/.ssh/known_hosts" | sed 's/[, ].*//' | tr -d '[]' | sed 's/:[0-9]\+$//' | sort | uniq)" ssh
fi

# complete sudo commands
complete -cf sudo
