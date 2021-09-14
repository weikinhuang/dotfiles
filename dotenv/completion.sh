#!/bin/bash
# SSH auto-completion based on entries in known_hosts.
if ! complete | grep ' ssh$' -q; then
  complete -o default -W "$(
    (
      grep '^Host ' "${HOME}/.ssh/config" "${HOME}"/.ssh/config.d/* 2>/dev/null | grep -v no-complete | cut -d ' ' -f 2- | tr ' ' '\n' | grep -v '[?*]'
      [[ -e "${HOME}/.ssh/known_hosts" ]] && sed 's/[, ].*//' <"${HOME}/.ssh/known_hosts" | tr -d '[]' | sed 's/:[0-9]\+$//' | grep -v '|'
    ) \
      | sort | uniq
  )" ssh
fi

# complete sudo commands
complete -cf sudo
