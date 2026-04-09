# shellcheck shell=bash
# Time segment caching subsystem.
# Sourced from dotenv/prompt.sh during the prompt phase.
# SPDX-License-Identifier: MIT

__dot_ps1_time_color_day=
__dot_ps1_time_color_night=
__dot_ps1_time_day_start=8
__dot_ps1_time_day_end=18
__dot_ps1_time_segment=

function internal::ps1-time-config-refresh() {
  local day_start day_end
  internal::ps1-resolve-color DOT_PS1_COLOR_TIME_DAY '\[\e[38;5;244m\]' __dot_ps1_time_color_day
  internal::ps1-resolve-color DOT_PS1_COLOR_TIME_NIGHT '\[\e[38;5;033m\]' __dot_ps1_time_color_night
  day_start="${DOT_PS1_DAY_START:-8}"
  day_end="${DOT_PS1_DAY_END:-18}"
  [[ "${day_start}" =~ ^[0-9]+$ ]] || day_start=8
  [[ "${day_end}" =~ ^[0-9]+$ ]] || day_end=18
  __dot_ps1_time_day_start="${day_start}"
  __dot_ps1_time_day_end="${day_end}"
}

function internal::ps1-time-refresh() {
  if [[ " ${DOT_PS1_SEGMENTS[*]} ${DOT_SUDO_PS1_SEGMENTS[*]} " != *' time '* ]]; then
    __dot_ps1_time_segment=
    return 0
  fi

  local hour_text hour time_text color color_rendered reset_rendered
  printf -v hour_text '%(%H)T' -1
  hour=$((10#${hour_text}))
  color="${__dot_ps1_time_color_night}"
  if ((hour >= __dot_ps1_time_day_start && hour <= __dot_ps1_time_day_end)); then
    color="${__dot_ps1_time_color_day}"
  fi
  printf -v time_text '%(%I:%M:%S)T' -1
  internal::ps1-render-literal "${color}" color_rendered
  internal::ps1-render-literal "${__dot_ps1_reset}" reset_rendered
  __dot_ps1_time_segment="${color_rendered}${time_text}${reset_rendered} "
}

internal::ps1-time-config-refresh
internal::ps1-time-refresh
internal::prompt-action-push internal::ps1-time-refresh
