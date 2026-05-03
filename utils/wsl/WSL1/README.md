# Windows Subsystem for Linux 1 notes

This page is only for intentionally running a distro on WSL 1. For the normal install flow, start with
[../README.md](../README.md).

## Install WSL 1

For a fresh WSL 1 install on current Windows builds, use an elevated PowerShell prompt:

```powershell
wsl --install --enable-wsl1 --no-distribution
wsl --set-default-version 1
wsl --install -d Ubuntu
```

Restart Windows if the first command prompts for it, then continue with the remaining steps.

If you already have a distro installed and want to convert it to WSL 1:

```powershell
wsl --set-version Ubuntu 1
```

If `wsl --install` is unavailable on your Windows build, use Microsoft's legacy guidance:
[Manual installation steps for older versions of WSL](https://learn.microsoft.com/en-us/windows/wsl/install-manual).

## Optional: change the Linux home directory to the Windows profile

Microsoft recommends keeping Linux project files in the Linux filesystem for the best compatibility and performance.
Only point `$HOME` into `/mnt/c/...` if you specifically want your shell config to live in the Windows profile and you
accept the tradeoff.

Edit `/etc/passwd`:

```bash
sudo vi /etc/passwd
```

Change:

```text
WSLUSERNAME:x:1000:1000:,,,:/home/WSLUSERNAME:/bin/bash
```

to:

```text
WSLUSERNAME:x:1000:1000:,,,:/mnt/c/Users/WINDOWSUSERNAME:/bin/bash
```

## `sshd`

Setting up `sshd` is useful if you want to connect to WSL from tools that do not speak WSL directly.

### Install and configure `sshd`

Install the server:

```bash
sudo apt-get install openssh-server
```

Update the SSH server config:

```bash
sudo vi /etc/ssh/sshd_config
```

Recommended baseline:

```text
Port 2222
ListenAddress 127.0.0.1
ListenAddress ::1
PermitRootLogin no
AllowUsers WSLUSERNAME
PasswordAuthentication no
PubkeyAuthentication yes
```

Make sure the runtime directory exists, then restart the service:

```bash
sudo mkdir -p /run/sshd
sudo service ssh --full-restart
```

Copy your client public key into `~/.ssh/authorized_keys` and keep the usual permissions:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
vi ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Start `sshd` on Windows logon

1. Allow the base user to start `sshd` without a password:

```bash
sudo visudo
```

Append the following lines before `#includedir /etc/sudoers.d`:

```text
# Allow base user to start up sshd on Windows login
WSLUSERNAME ALL=(ALL) NOPASSWD: /usr/sbin/sshd
WSLUSERNAME ALL=(ALL) NOPASSWD: /bin/mkdir -p /run/sshd
WSLUSERNAME ALL=(ALL) NOPASSWD: /usr/bin/rm -f /var/run/sshd.pid
```

2. Install the Windows scheduled task. Adjust the repo path first if needed:

```bash
bash ~/.dotfiles/utils/wsl/WSL1/sshd-on-boot.sh
```

Note: this causes a short-lived PowerShell window to appear during login.
