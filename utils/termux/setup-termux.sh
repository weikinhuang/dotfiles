#!/data/data/com.termux/files/usr/bin/bash
# Install the base Termux packages for the dotfiles environment.
# SPDX-License-Identifier: MIT

pkg upgrade

pkg install \
  bash-completion \
  bc \
  ca-certificates \
  coreutils \
  curl \
  diffutils \
  direnv \
  dnsutils \
  findutils \
  git \
  htop \
  iproute2 \
  jq \
  less \
  make \
  ncurses-utils \
  net-tools \
  openssh \
  openssl \
  openssl-tool \
  perl \
  procps \
  ripgrep \
  rsync \
  screen \
  socat \
  sshpass \
  tmux \
  unzip \
  vim \
  wget

pkg install \
  termux-am \
  termux-api \
  termux-exec \
  termux-services \
  termux-tools
