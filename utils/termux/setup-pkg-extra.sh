#!/data/data/com.termux/files/usr/bin/bash
# Install additional Termux packages for the dotfiles environment.
# SPDX-License-Identifier: MIT

pkg upgrade

pkg install \
  bat \
  difftastic \
  eza \
  fd \
  ffmpeg \
  fzf \
  git-delta
  helm \
  hexyl \
  imagemagick \
  kubectl \
  kubelogin \
  lesspipe \
  mosh \
  neovim \
  nodejs \
  proot \
  proot-distro \
  tmux \
  websocat \
  yq \
  zoxide
