# shellcheck shell=bash
# Bash completion for the WSL `pbcopy` wrapper around clip.exe.
# SPDX-License-Identifier: MIT

complete -W "-h --help" -o default pbcopy
