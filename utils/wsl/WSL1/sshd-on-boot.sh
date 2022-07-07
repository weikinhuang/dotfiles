#!/usr/bin/env bash

#env
# list tasks with powershell:
#    Get-ScheduledTask –TaskPath "\"
# export task with:
#    Export-ScheduledTask -TaskName wsl-sshd -TaskPath \

# get the windows username
function winwhoami() {
  # shellcheck disable=SC2016
  powershell.exe -NoProfile -NonInteractive -Command '$env:USERNAME' </dev/null | tr -d '\r'
}

function win-profile-dir() {
  # shellcheck disable=SC2016
  powershell.exe -NoProfile -NonInteractive -Command '$env:USERPROFILE' </dev/null | tr -d '\r'
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
