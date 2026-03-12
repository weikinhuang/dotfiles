#!/usr/bin/env bash
# Bootstrap dotfiles in the Docker test container.
# SPDX-License-Identifier: MIT

# auto setup
if [[ ! -L /root/.bashrc ]]; then
  (cd ~ && .dotfiles/bootstrap.sh)
fi

exec bash --noprofile --norc
