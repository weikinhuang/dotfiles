# Windows Subsystem Linux setup

For full documentation see [docs.microsoft.com](https://docs.microsoft.com/en-us/windows/wsl/install-win10).

## Install the Windows Subsystem for Linux

- For **WSL 1** see [./WSL1/README.md](./WSL1/README.md)
- For **WSL 2** see [./WSL2/README.md](./WSL2/README.md)

## Set up wsl configurations

### Setup `wsl.conf`

See [Automatically Configuring WSL](https://blogs.msdn.microsoft.com/commandline/2018/02/07/automatically-configuring-wsl/) on microsoft.com for explanation of options.

Edit `/etc/wsl.conf` with:

```bash
sudo vi /etc/wsl.conf
```

Add contents:

```text
# Let's enable extra metadata options by default
[automount]
enabled = true
root = /mnt/
options = "metadata,umask=22,fmask=11"
mountFsTab = true

# Let's enable DNS – even though these are turned on by default, we'll specify here just to be explicit.
[network]
generateHosts = true
generateResolvConf = true

# Set up windows/linux interop
[interop]
enabled = true
appendWindowsPath = true
```

## Allow the `sudo` group to use sudo without a password

Edit the sudoers file

```bash
sudo visudo
```

Change the following block:

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
    apt-transport-https \
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
    netcat \
    openssl \
    procps \
    python3-venv \
    python3-pip \
    rsync \
    screen \
    socat \
    unzip \
    vim \
    wget \
    xxd
```

## Updating Packages in WSL

```bash
sudo apt-get update && sudo apt-get upgrade
```

## Updating the Ubuntu OS

```bash
sudo -S apt-mark hold procps strace sudo
sudo -S env RELEASE_UPGRADER_NO_SCREEN=1 do-release-upgrade
```

## `winsudo` setup

`winsudo` allows you to run applications in Windows elevated user mode from a non-elevated wsl shell.

The only requirement is that `openssh-server` is installed.

**How it works**: When run, `winsudo` uses `powershell` to start a elevated wsl process running `sshd` under the current linux user with a random port and a generated ssh key. It then forwards the command through an `ssh` connection from the non-elevated to the elevated `sshd` server. Any process that works under `ssh` should work with `winsudo`.

You can test if `winsudo` is working properly with `winsudo net.exe sessions` and comparing the output with just running `net.exe sessions`. Running without elevated permissions should result in `Access is denied.`.

## Native process proxy wrappers

Wrapper `bat` files are provided for `git` and `ssh` to allow programs to use the WSL version of these programs instead of the Windows versions. If an application can specify the binary path for these programs, then these `bat` scripts can be used.

Below are some usage examples.

### SSH wrapper for VSCode IDE

Set the ssh path to the ssh wrapper:

```text
Edit > Preferences > Settings
```

```json
{
    "remote.SSH.path": "DOTFILES_PATH\\utils\\wsl\\native-wrappers\\ssh.bat",
}
```

### Git wrapper for IntelliJ (ie. Webstorm) based IDEs

Set the git path to the git wrapper:

```text
Settings > Version Control > Git > Path to Git executable: [DOTFILES_PATH\utils\wsl\native-wrappers\git.bat]
```

### Git wrapper for VSCode IDE

Set the git path to the git wrapper:

```text
Edit > Preferences > Settings
```

```json
{
    "git.path": "DOTFILES_PATH\\utils\\wsl\\native-wrappers\\git.bat",
    "terminal.integrated.shell.windows": "C:\\Windows\\System32\\wsl.exe"
}
```
