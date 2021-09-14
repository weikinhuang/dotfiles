#!/usr/bin/env bash

#env
# list tasks with powershell:
#    Get-ScheduledTask –TaskPath "\"
# export task with:
#    Export-ScheduledTask -TaskName wsl-sshd -TaskPath \

# get the windows username
function winwhoami() {
  /mnt/c/Windows/System32/cmd.exe /c 'echo %USERNAME%' | sed -e 's/\r//g'
}

function win-profile-dir() {
  wslpath -u "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %USERPROFILE%' | sed -e 's/\r//g')"
}

function setup-run-exe() {
  # dotfiles is setup under drvfs
  if ! wslpath -w "$(command -v run.exe)" &>/dev/null; then
    mkdir -p "$(wslpath -u "$(win-profile-dir)/bin")"
    cp "$(command -v run.exe)" "$(win-profile-dir)/bin"
    wslpath -wa "$(win-profile-dir)/bin/run.exe"
    return 0
  fi
  # this is at a windows accessible location
  wslpath -wa "$(command -v run.exe)"
}

WORKDIR="$(dirname "$(realpath "$0")")"
PROFILE_DIR="$(win-profile-dir)"

# regular sshd
cp "${WORKDIR}/win-schtasks-ssh.xml" "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"

sed -i 's/##HOSTNAME##/'"$(hostname)"'/' "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
sed -i 's/##USER##/'"$(winwhoami)"'/' "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
sed -i 's!##RUN_EXE##!'"$(setup-run-exe | sed 's/\\/\\\\/g')"'!' "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
sed -i 's!##SSHD_RUN_SCRIPT##!'"$(command -v __sshd_auto_start.sh)"'!' "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"

schtasks.exe /delete /f /tn wsl-sshd
schtasks.exe /create /xml "$(wslpath -wa "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml")" /tn wsl-sshd

cat "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
rm -f "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
