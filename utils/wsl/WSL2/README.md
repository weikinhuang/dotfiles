# Windows Subsystem Linux 2 misc files

For full documentation see [docs.microsoft.com](https://docs.microsoft.com/en-us/windows/wsl/install-win10).

## Install the Windows Subsystem for Linux

Before installing any Linux distros for WSL, you must ensure that the "Windows Subsystem for Linux" optional feature is enabled:

1. Open PowerShell as Administrator and run:

    1. Enable the Windows Subsystem for Linux

        ```powershell
        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
        ```

    2. Enable Virtual Machine feature

        ```powershell
        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
        dism.exe /online /enable-feature /featurename:Microsoft-Hyper-V-Management-PowerShell /all /norestart
        ```

2. Install the Linux kernel update package
    1. Download [WSL2 Linux kernel update package for x64 machines](https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi)
    2. Install package.
3. Restart your computer.
4. Download and install from the Windows Store: search `Run Linux on Windows`
    - [Ubuntu](https://www.microsoft.com/en-us/p/ubuntu-2004-lts/9n6svws3rx71)
5. From the distro's page, select "Get"
6. Now that your Linux distro is installed, you must initialize your new distro instance once, before it can be used.

## Setting WSL to version 2

Open PowerShell as Administrator and run:

```powershell
# to show all installed WSL distributions
wsl --list --verbose
# change the version
wsl --set-version <distribution name> <versionNumber>
# ex.
wsl --set-version Ubuntu 2
```

Optionally, setting WSL2 as the default is also possible

```powershell
wsl --set-default-version 2
```

## Optimize VHDX file to reclaim space

Open PowerShell as Administrator and run:

```powershell
# zero out empty space
# https://github.com/microsoft/WSL/issues/4699#issuecomment-722547552
wsl -e sudo fstrim /

# shutdown all WSL2 instances
wsl --shutdown

# find all vhd files
Set-Location $env:LOCALAPPDATA\Packages
get-childitem -recurse -filter "ext4.vhdx" -ErrorAction SilentlyContinue

# go through each directory and optimize the vhd
# Set-Location C:\Users\USERNAME\AppData\Local\Packages\CanonicalGroupLimited.UbuntuonWindows_79rhkp1fndgsc\LocalState
optimize-vhd -Path .\ext4.vhdx -Mode full
```

### Docker Desktop for Windows

```powershell
# Docker wsl2 vhdx files are located in a different directory
Set-Location $env:LOCALAPPDATA\Docker
get-childitem -recurse -filter "ext4.vhdx" -ErrorAction SilentlyContinue
```

### Windows 10 Home edition

Windows 10 Home does not include `optimize-vhd`, so a different set of commands must be run

Open PowerShell as Administrator and run:

```powershell
# zero out empty space
# https://github.com/microsoft/WSL/issues/4699#issuecomment-722547552
wsl -e sudo fstrim /

# shutdown all WSL2 instances
wsl --shutdown

# open window Diskpart
diskpart
select vdisk file="C:\WSL-Distros\...\ext4.vhdx"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```
