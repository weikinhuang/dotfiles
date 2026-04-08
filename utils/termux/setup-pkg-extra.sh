#!/data/data/com.termux/files/usr/bin/bash
# Install additional Termux packages for the dotfiles environment.
# SPDX-License-Identifier: MIT

pkg upgrade

pkg install \
  bat \
  difftastic \
  eza \
  fd \
  fzf \
  git-delta \
  helm \
  hexyl \
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

# this is needed for neovim/vim plugins
pkg install \
  build-essentials

# Optional: this adds ~700MB in packages
# pkg install \
#   ffmpeg \
#   imagemagick
