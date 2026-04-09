# shellcheck shell=bash
# Enhance ls aliases with OSC 8 terminal hyperlinks.
# SPDX-License-Identifier: MIT

# Hyperlinks are suppressed over SSH (remote file:// paths are inaccessible
# locally) and when the user opts out via DOT_DISABLE_HYPERLINKS.
if [[ -n "${DOT_DISABLE_HYPERLINKS:-}" ]] || [[ -n "${DOT___IS_SSH:-}" ]]; then
  return
fi

# Re-detect the ls binary (PATH may have changed since dotenv/aliases.sh,
# e.g. Homebrew adding GNU coreutils on macOS).
__dot_ls_bin="$(
  unalias ls &>/dev/null
  command -v ls
)"

# Only GNU coreutils ls (>= 8.28) supports --hyperlink.
if ! "${__dot_ls_bin}" --hyperlink=auto / &>/dev/null; then
  unset __dot_ls_bin
  return
fi

if "${__dot_ls_bin}" --color &>/dev/null; then
  __dot_ls_color_flag="--color=auto"
else
  __dot_ls_color_flag="-G"
fi

if [[ -n "${DOT___IS_WSL:-}" ]]; then
  # On WSL, ls uses the Linux hostname in file:// URLs which Windows apps
  # cannot resolve; pipe through osc8-wsl-rewrite to fix the authority.
  # shellcheck disable=SC2139
  alias la="internal::osc8-wsl-rewrite ${__dot_ls_bin} -lA ${__dot_ls_color_flag} --hyperlink=always"
  # shellcheck disable=SC2139
  alias ll="internal::osc8-wsl-rewrite ${__dot_ls_bin} -l ${__dot_ls_color_flag} --hyperlink=always"
  # shellcheck disable=SC2139
  alias l.="internal::osc8-wsl-rewrite ${__dot_ls_bin} -d ${__dot_ls_color_flag} --hyperlink=always .*"
  # shellcheck disable=SC2139
  alias ls="internal::osc8-wsl-rewrite ${__dot_ls_bin} ${__dot_ls_color_flag} --hyperlink=always"
else
  # shellcheck disable=SC2139
  alias la="${__dot_ls_bin} -lA ${__dot_ls_color_flag} --hyperlink=auto"
  # shellcheck disable=SC2139
  alias ll="${__dot_ls_bin} -l ${__dot_ls_color_flag} --hyperlink=auto"
  # shellcheck disable=SC2139
  alias l.="${__dot_ls_bin} -d ${__dot_ls_color_flag} --hyperlink=auto .*"
  # shellcheck disable=SC2139
  alias ls="${__dot_ls_bin} ${__dot_ls_color_flag} --hyperlink=auto"
fi

if "${__dot_ls_bin}" --format=long &>/dev/null; then
  # shellcheck disable=SC2139
  alias dir="${__dot_ls_bin} ${__dot_ls_color_flag} --format=vertical"
  # shellcheck disable=SC2139
  alias vdir="${__dot_ls_bin} ${__dot_ls_color_flag} --format=long"
fi

unset __dot_ls_bin __dot_ls_color_flag
