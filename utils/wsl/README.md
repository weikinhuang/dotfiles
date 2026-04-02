# Windows Subsystem for Linux setup

For current platform guidance, start with [Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

## Install WSL

On current Windows 10/11 builds, install WSL from an elevated PowerShell prompt:

```powershell
wsl --install
```

If WSL is already installed and you only want to add a distro:

```powershell
wsl --list --online
wsl --install -d Ubuntu
```

New distro installs default to WSL 2. To change the default for future installs:

```powershell
wsl --set-default-version 2
# or
wsl --set-default-version 1
```

Check or update the WSL runtime itself with:

```powershell
wsl --status
wsl --version
wsl --update
```

- For WSL 1-specific notes see [./WSL1/README.md](./WSL1/README.md)
- For WSL 2-specific notes see [./WSL2/README.md](./WSL2/README.md)

## Set up WSL configuration

See [Advanced settings configuration in WSL](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) for the current option reference.

Edit `/etc/wsl.conf` with:

```bash
sudo vi /etc/wsl.conf
```

Example baseline config:

```text
[automount]
enabled = true
root = /mnt/
options = "metadata,umask=22,fmask=11"
mountFsTab = true

[network]
generateHosts = true
generateResolvConf = true

[interop]
enabled = true
appendWindowsPath = true
```

If you are on WSL 2, running WSL `0.67.6+`, and want `systemd`-managed services, add:

```text
[boot]
systemd = true
```

Apply changes from PowerShell:

```powershell
wsl.exe --shutdown
```

## Allow the `sudo` group to use sudo without a password

Convenient for a personal dev box, but not a good default on shared machines.

Edit the sudoers file:

```bash
sudo visudo
```

Change:

```text
# Allow members of group sudo to execute any command
%sudo   ALL=(ALL:ALL) ALL
```

to:

```text
# Allow members of group sudo to execute any command
%sudo   ALL=(ALL:ALL) NOPASSWD: ALL
```

## Install useful utilities

```bash
sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    bash-completion \
    bc \
    ca-certificates \
    curl \
    direnv \
    dnsutils \
    git \
    gnupg \
    htop \
    jq \
    make \
    netcat-openbsd \
    openssh-client \
    openssl \
    procps \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    screen \
    socat \
    tree \
    unzip \
    vim \
    wget \
    xxd \
    zip \
    zstd
```

## Update packages inside WSL

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

## Upgrade the Ubuntu distro release

```bash
sudo do-release-upgrade
```

## `winsudo` setup

`winsudo` allows you to run Windows applications with elevated privileges from a non-elevated WSL shell.

### Native sudo (`sudo.exe`)

On current Windows builds that ship `sudo.exe`, `winsudo` prefers the native flow.

`winsudo` requires inline mode (`normal`). Microsoft recommends `forceNewWindow`
by default for security, so only switch to inline mode if you understand that tradeoff.

**Setup:**

1. Enable sudo in Windows Settings.
   On Windows 11 24H2 this appears under **System > For Developers**.
   On Windows 11 25H2 and later it is surfaced under **System > Advanced**.
2. Set inline mode from an elevated (admin) prompt:

```powershell
sudo config --enable normal
```

3. Verify the configuration:

```powershell
sudo config
# Expected output mentions "Inline" mode
```

### Legacy fallback (without usable `sudo.exe`)

On older Windows versions without `sudo.exe`, or when `sudo.exe` is not configured for inline mode, `winsudo` falls back to an SSH-based elevation mechanism.

**Requirements:** `openssh-server` must be installed so `sshd` is available:

```bash
sudo apt-get install openssh-server
```

**How it works:** `winsudo` uses PowerShell `Start-Process -Verb RunAs` to launch an elevated WSL process running `sshd` on a random port with a generated SSH key, then forwards commands through that SSH session.

### Testing

Test with `winsudo net.exe sessions` and compare it with plain `net.exe sessions`. The non-elevated version should return `Access is denied.`.

## Native process proxy wrappers

Wrapper `.bat` files are provided for `git` and `ssh` so Windows-native tools can delegate to the WSL versions instead of the Windows ones.

### SSH wrapper for VS Code

Point the SSH client path at the wrapper:

```json
{
  "remote.SSH.path": "DOTFILES_PATH\\utils\\wsl\\native-wrappers\\ssh.bat"
}
```

### Git wrapper for JetBrains IDEs

Set the Git executable path to:

```text
DOTFILES_PATH\utils\wsl\native-wrappers\git.bat
```

### Git wrapper for VS Code

Set the Git path to the wrapper. If you also want Windows-hosted VS Code terminals to open in WSL by default, use a terminal profile instead of the deprecated `terminal.integrated.shell.windows` setting:

```json
{
  "git.path": "DOTFILES_PATH\\utils\\wsl\\native-wrappers\\git.bat",
  "terminal.integrated.profiles.windows": {
    "WSL": {
      "path": "C:\\Windows\\System32\\wsl.exe"
    }
  },
  "terminal.integrated.defaultProfile.windows": "WSL"
}
```
