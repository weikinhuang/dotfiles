# shellcheck shell=bash
# Load-average segment caching subsystem.
# Sourced from dotenv/prompt.sh during the prompt phase.
# SPDX-License-Identifier: MIT

__dot_ps1_load_colors=()
__dot_ps1_loadavg_segment=

function internal::ps1-loadavg-config-refresh() {
  if [[ -n "${DOT_PS1_MONOCHROME:-}" ]]; then
    __dot_ps1_load_colors=('')
  elif declare -p DOT_PS1_COLOR_LOAD &>/dev/null; then
    eval "__dot_ps1_load_colors=(\"\${DOT_PS1_COLOR_LOAD[@]}\")"
  else
    __dot_ps1_load_colors=(
      '\[\e[38;5;111m\]' # #87afff
      '\[\e[38;5;110m\]' # #87afd7
      '\[\e[38;5;109m\]' # #87afaf
      '\[\e[38;5;108m\]' # #87af87
      '\[\e[38;5;107m\]' # #87af5f
      '\[\e[38;5;106m\]' # #87af00
      '\[\e[38;5;178m\]' # #d7af00
      '\[\e[38;5;172m\]' # #d78700
      '\[\e[38;5;166m\]' # #d75f00
      '\[\e[38;5;167m\]' # #d75f5f
    )
  fi

  if ((${#__dot_ps1_load_colors[@]} == 0)); then
    __dot_ps1_load_colors=('')
  fi
}

function internal::ps1-loadavg-refresh() {
  if [[ " ${DOT_PS1_SEGMENTS[*]} ${DOT_SUDO_PS1_SEGMENTS[*]} " != *' loadavg '* ]]; then
    __dot_ps1_loadavg_segment=
    return 0
  fi
  if ! declare -F internal::ps1-proc-use &>/dev/null; then
    __dot_ps1_loadavg_segment=
    return 0
  fi

  local load color load_count load_index color_rendered reset_rendered
  load="$(internal::ps1-proc-use)" || {
    __dot_ps1_loadavg_segment=
    return 0
  }
  load_count=${#__dot_ps1_load_colors[@]}
  color=
  if ((load_count > 0)); then
    load_index="${load%%.*}"
    [[ -n "${load_index}" ]] || load_index=0
    [[ "${load_index}" =~ ^[0-9]+$ ]] || load_index=0
    if ((load_index >= load_count)); then
      load_index=$((load_count - 1))
    fi
    color="${__dot_ps1_load_colors[load_index]}"
  fi
  internal::ps1-render-literal "${color}" color_rendered
  internal::ps1-render-literal "${__dot_ps1_reset}" reset_rendered
  __dot_ps1_loadavg_segment="${color_rendered}${load}${reset_rendered} "
}

internal::ps1-loadavg-config-refresh
if declare -F internal::ps1-proc-use &>/dev/null; then
  internal::ps1-loadavg-refresh
fi
internal::prompt-action-push internal::ps1-loadavg-refresh
