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

# Let's enable DNS – even though these are turned on by default, we’ll specify here just to be explicit.
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
    #UsePrivilegeSeparation no 
    ```

1. Restart the sshd service

    ```bash
    sudo service ssh --full-restart
    ```
