# Termux Android Terminal Emulator

Termux is an Android terminal emulator and Linux environment app that works directly with no rooting or setup required. A minimal base system is installed automatically - additional packages are available using the APT package manager.

## Detection

The termux environment can be detected with:

```bash
if command -v termux-setup-storage &>/dev/null; then
  IS_TERMUX=1
fi
```

## Packages

Install common utilities:

```bash
bash ~/.dotfiles/utils/termux/setup-termux.sh
```

Install extra packages:

```bash
bash ~/.dotfiles/utils/termux/setup-pkg-extra.sh
```

## Request permissions to access local storage

Setup access to the /data/Downloads folder on shared storage.

See [termux-setup-storage](https://wiki.termux.com/wiki/Termux-setup-storage) for more information.

```bash
termux-setup-storage
```

This will mount shared storage to `~/storage`.

## Useful shortcuts to add to ~/.bash_local`

```bash
# Shortcuts to the clipboard
alias pbcopy="termux-clipboard-set"
alias pbpaste="termux-clipboard-get"
```

## Symlinks for persistent profiles

Symlink `.bash_history`

```bash
touch ~/storage/downloads/Sync/.bash_history
ln -sf ~/storage/downloads/Sync/.bash_history
```

Symlink `.bash_local`

```bash
touch ~/storage/downloads/Sync/.bash_local
ln -sf ~/storage/downloads/Sync/.bash_local
```

Symlink `.gitconfig.local`

```bash
touch ~/storage/downloads/Sync/.gitconfig.local
ln -sf ~/storage/downloads/Sync/.gitconfig.local
```

## Setup a `proot` linux environment

Setup a debian environment:

```bash
proot-distro install debian
```

Login to the debian environment:

```bash
proot-distro login debian
```

See [`PRoot`](https://wiki.termux.com/wiki/PRoot) and [`proot-distro`](https://github.com/termux/proot-distro) for more information.

## Setup sshd to connect to android device

### Configure `sshd`

Configure `sshd` with better defaults

```bash
vi /data/data/com.termux/files/usr/etc/ssh/sshd_config
```

With:

```text
# Use most defaults for sshd configuration.
ClientAliveInterval 180
UseDNS no
PrintMotd yes
PermitRootLogin No

# sshd modern configuration
# https://infosec.mozilla.org/guidelines/openssh.html

# Supported HostKey algorithms by order of preference.
HostKey /data/data/com.termux/files/usr/etc/ssh/ssh_host_ed25519_key
HostKey /data/data/com.termux/files/usr/etc/ssh/ssh_host_rsa_key
HostKey /data/data/com.termux/files/usr/etc/ssh/ssh_host_ecdsa_key

KexAlgorithms curve25519-sha256@libssh.org,ecdh-sha2-nistp521,ecdh-sha2-nistp384,ecdh-sha2-nistp256,diffie-hellman-group-exchange-sha256

Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr

MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com,hmac-sha2-512,hmac-sha2-256,umac-128@openssh.com

# Password based logins are disabled - only public key based logins are allowed.
AuthenticationMethods publickey

# LogLevel VERBOSE logs user's key fingerprint on login. Needed to have a clear audit track of which key was using to log in.
LogLevel VERBOSE

# Log sftp level file access (read/write/etc.) that would not be easily logged otherwise.
Subsystem sftp /data/data/com.termux/files/usr/libexec/sftp-server -f AUTHPRIV -l INFO
```

### Running `sshd`

Start the server with:

```bash
sshd
```

Stop the server with:

```bash
pkill sshd
```

### Copy ssh authorized_keys

```bash
cat ~/storage/downloads/Sync/authorized_keys >| ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Connect to termux

```bash
ssh -p 8022 192.IPofAndroidDevice
```

### sshd Notes

- [Remote Access](https://wiki.termux.com/wiki/Remote_Access)
