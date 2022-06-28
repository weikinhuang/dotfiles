# Termux Android Terminal Emulator

Termux is an Android terminal emulator and Linux environment app that works directly with no rooting or setup required. A minimal base system is installed automatically - additional packages are available using the APT package manager.

## Detection

The termux environment can be detected with:

```bash
if command -v termux-setup-storage &>/dev/null; then
  IS_TERMUX=1
fi
```

## Useful shortcuts to add to ~/.bash_local`

```bash
# Shortcuts to the clipboard
alias pbcopy="termux-clipboard-set"
alias pbpaste="termux-clipboard-get"
```
