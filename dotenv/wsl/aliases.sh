# shellcheck shell=bash
# useful shortcuts
alias open="winstart"

# Alias vi to vscode or notepad++
if type code-insiders &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server-insiders/bin/" && ! (echo "${PATH}" | grep -q "/.vscode-server/bin/"); then
  alias vi="code-insiders --wait"
elif type code &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server/bin/"; then
  alias vi="code --wait"
elif type npp &>/dev/null; then
  alias vi="npp"
fi

# Shortcuts to the clipboard
# @todo: Figure this out
#alias pbcopy="putclip"
#alias pbpaste="getclip"
