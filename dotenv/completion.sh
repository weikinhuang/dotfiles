# SSH auto-completion based on entries in known_hosts.
if [[ -e "${HOME}/.ssh/known_hosts" ]]; then
  complete -o default -W "$(cat "${HOME}/.ssh/known_hosts" | sed 's/[, ].*//' | tr -d '[]' | sed 's/:[0-9]\+$//' | sort | uniq)" ssh
fi

# complete sudo commands
complete -cf sudo
