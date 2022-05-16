# shellcheck shell=bash
# useful shortcuts
alias open="winstart"

# Alias vi to vscode or notepad++
if command -v code-insiders &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server-insiders/bin/" && ! (echo "${PATH}" | grep -q "/.vscode-server/bin/"); then
  alias vi="code-insiders --wait"
elif command -v code &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server/bin/"; then
  alias vi="code --wait"
elif command -v npp &>/dev/null; then
  alias vi="npp"
fi

# Shortcuts to the clipboard
# @todo: Figure this out
#alias pbcopy="putclip"
#alias pbpaste="getclip"
