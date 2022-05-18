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

WORKDIR="$(dirname "$(realpath "$0")")"
PROFILE_DIR="$(win-profile-dir)"

# regular sshd
cp "${WORKDIR}/win-schtasks-ssh.xml" "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"

sed -i "s/##HOSTNAME##/$(hostname)/" "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
sed -i "s/##USER##/$(winwhoami)/" "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
sed -i "s!##SSHD_RUN_SCRIPT##!$(command -v __sshd_auto_start.sh)!" "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"

set -x
schtasks.exe /delete /f /tn wsl-sshd
schtasks.exe /create /xml "$(wslpath -wa "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml")" /tn wsl-sshd
set +x

cat "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
rm -f "${PROFILE_DIR}/win-schtasks-ssh.tmp.xml"
