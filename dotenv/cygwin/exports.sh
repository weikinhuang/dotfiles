# shellcheck shell=bash
# Number of threads that is available
if [[ -r /proc/cpuinfo ]]; then
  # for cygwin based environments
  export PROC_CORES=$(grep "^processor" -c /proc/cpuinfo)
else
  # for mingw based environments
  export PROC_CORES=$("$(cygpath --windir)/syswow64/WindowsPowerShell/v1.0/powershell.exe" get-wmiobject Win32_ComputerSystem\|format-list *proc* | grep 'Logical' | sed 's/^.\+ : //')
fi

# The windows userprofile directory
if [[ -z "${USERPROFILE}" ]]; then
  if [[ -d "$(cygpath --homeroot)/${USER}" ]]; then
    export USERPROFILE="$(cygpath -w "$(cygpath --homeroot)/${USER}")"
  else
    export USERPROFILE="$(cygpath -w ~)"
  fi
fi

if [[ -z "${APPDATA}" ]] && [[ -d "$(cygpath --homeroot)/${USER}/AppData/Roaming" ]]; then
  export APPDATA="$(cygpath -w "$(cygpath --homeroot)/${USER}/AppData/Roaming")"
fi

# use native symlinks when possible
export CYGWIN="${CYGWIN}${CYGWIN+ }winsymlinks:native nodosfilewarning"
