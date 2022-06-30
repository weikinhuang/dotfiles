#!/usr/bin/env bash

# auto setup
if [[ ! -L /root/.bashrc ]]; then
  (cd ~ && .dotfiles/bootstrap.sh)
fi

exec bash --noprofile --norc
