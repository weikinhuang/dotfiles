# shellcheck shell=bash
# Configure pnpm completion.
# SPDX-License-Identifier: MIT

# @see https://pnpm.io/completion
command -v pnpm &>/dev/null || return

internal::cached-completion pnpm "pnpm completion bash"
