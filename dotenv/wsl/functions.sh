# shellcheck shell=bash
# get the windows username
function winwhoami() {
  /mnt/c/Windows/System32/cmd.exe /c 'echo %USERNAME%' | sed -e 's/\r//g'
}

# check if this is a windows path
function is-volfs-readable() {
  if /bin/wslpath -w "$1" &>/dev/null; then
    return 0
  else
    return 1
  fi
}
export -f is-volfs-readable

# check if this is a wsl path
function is-drvfs-readable() {
  if /bin/wslpath -u "$1" &>/dev/null; then
    return 0
  else
    return 1
  fi
}
export -f is-drvfs-readable

# run a command under the windows shell
function cmd0() {
  cmd.exe /c "$@" | sed 's/\r$//'
  return "${PIPESTATUS[0]}"
}
