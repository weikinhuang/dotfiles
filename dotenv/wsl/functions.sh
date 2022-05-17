# shellcheck shell=bash
# get the windows username
function winwhoami() {
  /mnt/c/Windows/System32/cmd.exe /c 'echo %USERNAME%' | sed -e 's/\r//g'
}

# check if this is a wsl path
function is-volfs-readable() {
  /bin/wslpath -w "$1" &>/dev/null
}
export -f is-volfs-readable

# check if this is a windows path
function is-drvfs-readable() {
  /bin/wslpath -u "$1" &>/dev/null
}
export -f is-drvfs-readable

# run a command under the windows shell
function cmd0() {
  cmd.exe /c "$@" | sed 's/\r$//'
  return "${PIPESTATUS[0]}"
}

# checks if the current process (sesison) is running with Administrator privileges.
function is-elevated-session() {
  local ret out

  # try using powershell to determine elevated status
  out="$(powershell.exe -c '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)' | tr -d '\r')"
  ret=$?
  if [[ ${ret} -ne 0 ]]; then
    return 255
  fi
  [[ "${out}" == "True" ]]
}
