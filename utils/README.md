# Utils

Platform-specific setup guides and native wrapper scripts. Use the per-platform README to bring a fresh system up to the
point where the dotfiles bootstrap installs cleanly, and to find companion Windows/Android tooling that can't live
inside a POSIX shell.

## Platform guides

| Path                                     | Purpose                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`darwin/README.md`](./darwin/README.md) | macOS setup: Xcode CLI tools, Homebrew, `chsh`, recommended `defaults`, `DefaultKeyBinding.dict` install. |
| [`termux/README.md`](./termux/README.md) | Termux on Android: `pkg`/`apt` baseline, `~/storage`, `sshd` config, `proot-distro` Linux environments.   |
| [`wsl/README.md`](./wsl/README.md)       | Windows Subsystem for Linux: distro install, `/etc/wsl.conf` baseline, `winsudo`, native proxy wrappers.  |

## Native wrappers

| Path                                                                                                             | Purpose                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`wsl/native-wrappers/git.bat`](./wsl/native-wrappers/git.bat)                                                   | Lets Windows-native tools (JetBrains, VS Code) delegate `git` to the WSL version. |
| [`wsl/native-wrappers/ssh.bat`](./wsl/native-wrappers/ssh.bat)                                                   | Points VS Code Remote-SSH at the WSL `ssh` client.                                |
| [`darwin/DefaultKeyBinding.dict`](./darwin/DefaultKeyBinding.dict)                                               | macOS `HOME` / `END` remapping to match other platforms.                          |
| [`termux/setup-termux.sh`](./termux/setup-termux.sh), [`termux/setup-pkg-extra.sh`](./termux/setup-pkg-extra.sh) | Termux `pkg` bootstrap scripts - base + extras.                                   |

## Related docs

- [../AGENTS.md](../AGENTS.md) - root agent guide.
- [../README.md](../README.md) - installation and configuration overview.
- [../REFERENCE.md](../REFERENCE.md) - public shell interface (aliases, functions, env vars, `git` subcommands).
