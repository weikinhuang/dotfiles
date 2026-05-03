# Windows Subsystem for Linux 2 notes

This page covers WSL 2-specific notes. For the normal install flow, start with [../README.md](../README.md).

## Install WSL 2

For a fresh WSL 2 install on current Windows builds, use an elevated PowerShell prompt:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if the install command prompts for it, then launch Ubuntu once to finish distro initialization.

Future distro installs already default to WSL 2 on current WSL. To set that explicitly:

```powershell
wsl --set-default-version 2
```

If you already have a distro installed and want to convert it to WSL 2:

```powershell
wsl --set-version Ubuntu 2
```

If `wsl --install` is unavailable on your Windows build, use Microsoft's legacy guidance:
[Manual installation steps for older versions of WSL](https://learn.microsoft.com/en-us/windows/wsl/install-manual).

## Manage VHDX disk usage

WSL 2 stores each distro in an `ext4.vhdx` virtual disk. On current WSL releases, that disk grows automatically as
needed and has a 1 TB default maximum size.

### Enable sparse VHDs for newly created distros

For new WSL 2 distros, you can opt into sparse VHD creation in `%UserProfile%\.wslconfig`:

```ini
[experimental]
sparseVhd=true
```

Apply the change:

```powershell
wsl --shutdown
```

### Compact an existing distro after deleting files

First reclaim free blocks from inside Linux:

```bash
sudo fstrim -av
```

Then shut WSL down from an elevated PowerShell prompt:

```powershell
wsl --shutdown
```

Locate the distro VHD path:

```powershell
(Get-ChildItem -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss |
  Where-Object { $_.GetValue("DistributionName") -eq "Ubuntu" }).GetValue("BasePath") + "\ext4.vhdx"
```

Compact it with `diskpart`:

```powershell
diskpart
select vdisk file="C:\Users\USERNAME\AppData\Local\Packages\...\LocalState\ext4.vhdx"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```

This is the broadest manual compaction flow and works on Windows Home as well as Pro.
