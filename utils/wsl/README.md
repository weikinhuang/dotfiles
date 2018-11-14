# Windows Subsystem Linux misc files

## Install the Windows Subsystem for Linux

Before installing any Linux distros for WSL, you must ensure that the "Windows Subsystem for Linux" optional feature is enabled:

1. Open PowerShell as Administrator and run:
    ```powershell
    Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
    ```
1. Restart your computer when prompted.
1. Download and install from the Windows Store: search `Run Linux on Windows`
    - [Ubuntu](https://www.microsoft.com/store/p/ubuntu/9nblggh4msv6)
1. From the distro's page, select "Get"
1. Now that your Linux distro is installed, you must initialize your new distro instance once, before it can be used.

## Set up wsl configurations

#### Setup `wsl.conf`

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

## Change home directory to the Windows home dir

Changing the current user's home directory to be the equivalent windows home dir to persist settings on reinstall of WSL.

Edit `/etc/passwd` with:

```bash
sudo vi /etc/passwd
```

Change the line:

```text
WSLUSERNAME:x:1000:1000:,,,:/home/WSLUSERNAME:/bin/bash
```

to

```text
WSLUSERNAME:x:1000:1000:,,,:/mnt/c/Users/WINDOWSUSERNAME:/bin/bash
```

## Install sshd

Installing sshd lets us use other terminal emulators other than the default one.

1. Generate ssh keys for this user if not already there

    ```bash
    ssh-keygen -t rsa
    ```

1. Reinstall sshd

    ```bash
    sudo apt-get remove --purge openssh-server
    sudo apt-get install openssh-server
    ```

1. Update the sshd config, comment in or add the following lines:

    ```bash
    sudo vi /etc/ssh/sshd_config
    ```

    ```text
    Port 2222
    ListenAddress 127.0.0.1
    ListenAddress ::1
    PermitRootLogin no
    AllowUsers WSLUSERNAME
    PasswordAuthentication no
    #UsePrivilegeSeparation no # needed for older versions of WSL
    ```

    ```bash
    # on newer versions of ubuntu, instead of "UsePrivilegeSeparation no" create this directory
    sudo mkdir -p /run/sshd
    ```

1. Restart the sshd service

    ```bash
    sudo service ssh --full-restart
    ```

## Start up sshd on user logon

1. Set up `/etc/sudoers` file with sudo permissions for sshd

    ```bash
    sudo visudo
    ```

    Append the following lines before `#includedir /etc/sudoers.d`

    ```text
    # Allow base user to start up sshd on windows login
    WSLUSERNAME ALL=(ALL) NOPASSWD: /usr/sbin/sshd
    WSLUSERNAME ALL=(ALL) NOPASSWD: /bin/mkdir -p /run/sshd
    ```

1. Install the windows scheduled task, change the path to the dotfiles installation path if necessary.

    ```bash
    bash ~/.dotfiles/utils/wsl/sshd-on-boot.sh
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
    fasd \
    git \
    gnupg \
    htop \
    jq \
    netcat \
    openssl \
    procps \
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

## Git wrapper for IntelliJ (ie. Webstorm) based IDEs

Set the git path to the git wrapper:

```text
Settings > Version Control > Git > Path to Git executable: [DOTFILES_PATH\utils\wsl\native-wrappers\git.bat]
```

## Git wrapper for VSCode IDE

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
