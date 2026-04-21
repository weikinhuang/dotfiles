# shellcheck shell=bash
# Bash completion for the WSL2 `wusbipd` wrapper around usbipd.exe.
# SPDX-License-Identifier: MIT

complete -W "list bind unbind attach detach state -h --help" wusbipd
