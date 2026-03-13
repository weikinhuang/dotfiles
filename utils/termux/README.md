# Termux on Android

Termux is an Android terminal emulator and Linux environment app that runs directly on the device without root. A minimal base system is installed automatically and additional packages are available through `pkg` and `apt`.

## Detection

The Termux environment can be detected with:

```bash
if command -v termux-setup-storage &>/dev/null; then
  IS_TERMUX=1
fi
```

## Packages

Install the base packages used by these dotfiles:

```bash
bash ~/.dotfiles/utils/termux/setup-termux.sh
```

Install extra packages:

```bash
bash ~/.dotfiles/utils/termux/setup-pkg-extra.sh
```

## Grant access to shared storage

This prompts Android for storage permission and creates the `~/storage` symlinks:

```bash
termux-setup-storage
```

You should then have paths such as `~/storage/shared` and `~/storage/downloads`.

Keep repos, binaries, and other executable files under `$HOME` rather than `~/storage`; shared storage is mounted with `noexec` and has other filesystem limitations.

## Useful shortcuts for `~/.bash_local`

```bash
# Clipboard helpers
alias pbcopy="termux-clipboard-set"
alias pbpaste="termux-clipboard-get"
```

## Symlinks for persistent profiles

These examples keep small text config files in synced storage while leaving actual repos and executables under `$HOME`.

```bash
mkdir -p ~/storage/downloads/Sync/termux

touch ~/storage/downloads/Sync/termux/.bash_history
ln -sf ~/storage/downloads/Sync/termux/.bash_history ~/.bash_history

touch ~/storage/downloads/Sync/termux/.bash_local
ln -sf ~/storage/downloads/Sync/termux/.bash_local ~/.bash_local

touch ~/storage/downloads/Sync/termux/.gitconfig.local
ln -sf ~/storage/downloads/Sync/termux/.gitconfig.local ~/.gitconfig.local
```

## Set up a `proot` Linux environment

Install a Debian userspace:

```bash
proot-distro install debian
```

Log in:

```bash
proot-distro login debian
```

See [Termux docs](https://termux.dev/en/docs/) and [`proot-distro`](https://github.com/termux/proot-distro) for more details.

## Set up `sshd` to connect to the Android device

### Configure `sshd`

Install `openssh` first via the setup script above, then edit:

```bash
vi /data/data/com.termux/files/usr/etc/ssh/sshd_config
```

Recommended minimal changes:

```text
ClientAliveInterval 180
PasswordAuthentication no
PermitRootLogin no
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

Termux OpenSSH listens on port `8022` by default because unprivileged Android apps cannot bind to the standard privileged SSH port.

### Running `sshd`

Start the server:

```bash
sshd
```

Stop the server:

```bash
pkill sshd
```

### Install `authorized_keys`

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat ~/storage/downloads/Sync/authorized_keys >| ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Connect to Termux

The login name is whatever `whoami` prints inside Termux, for example `u0_a123`:

```bash
whoami
ssh -p 8022 u0_a123@192.168.1.50
```

## References

- [Termux docs](https://termux.dev/en/docs/)
- [Termux packages wiki](https://github.com/termux/termux-packages/wiki)
