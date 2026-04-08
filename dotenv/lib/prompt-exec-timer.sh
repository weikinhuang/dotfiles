# shellcheck shell=bash
# Command execution timer subsystem.
# Sourced from dotenv/prompt.sh during the prompt phase.
# SPDX-License-Identifier: MIT

# Detect nanosecond support when EPOCHREALTIME is unavailable.
# Sets __dot_ps1_no_exec_timer=1 when neither method works.
__dot_ps1_no_exec_timer=
if [[ -z "${EPOCHREALTIME:-}" ]]; then
  __dot_ps1_ns_check="$(date +%N)"
  if [[ -z "$__dot_ps1_ns_check" ]] || [[ "$__dot_ps1_ns_check" == "N" ]]; then
    __dot_ps1_no_exec_timer=1
  fi
  unset -v __dot_ps1_ns_check
fi

if [[ -z "${__dot_ps1_no_exec_timer}" ]]; then
  __dot_ps1_exectimer=0
  __dot_ps1_execduration=
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    function internal::ps1-exec-timer-start() {
      [[ __dot_ps1_exectimer -gt 0 ]] && return
      __dot_ps1_exectimer="${EPOCHREALTIME/./}"
    }
  else
    function internal::ps1-exec-timer-start() {
      [[ __dot_ps1_exectimer -gt 0 ]] && return
      __dot_ps1_exectimer=$(date +%s%N)
    }
  fi
  internal::array-append-unique preexec_functions internal::ps1-exec-timer-start

  function internal::ps1-exec-timer-stop() {
    if [[ __dot_ps1_exectimer -eq 0 ]]; then
      __dot_ps1_execduration=
      return
    fi
    local duration delta_us
    if [[ -n "${EPOCHREALTIME:-}" ]]; then
      delta_us=$((${EPOCHREALTIME/./} - __dot_ps1_exectimer))
    else
      delta_us=$((($(date +%s%N) - __dot_ps1_exectimer) / 1000))
    fi
    local us=$((delta_us % 1000))
    local ms=$(((delta_us / 1000) % 1000))
    local s=$(((delta_us / 1000000) % 60))
    local m=$(((delta_us / 60000000) % 60))
    local h=$((delta_us / 3600000000))
    if ((h > 0)); then
      duration=${h}h${m}m
    elif ((m > 0)); then
      duration=${m}m${s}s
    elif ((s >= 10)); then
      duration=${s}.$((ms / 100))s
    elif ((s > 0)); then
      duration=${s}.$(printf %03d $ms)s
    elif ((ms >= 100)); then
      duration=${ms}ms
    elif ((ms > 0)); then
      duration=${ms}.$((us / 100))ms
    else
      duration=${us}us
    fi

    __dot_ps1_exectimer=0
    __dot_ps1_execduration=" ${duration}"
  }
  internal::prompt-action-push internal::ps1-exec-timer-stop
fi
