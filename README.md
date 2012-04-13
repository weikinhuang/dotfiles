# weikinhuang's dotfiles

## Installation

### Install dotfiles with Git

You can clone the repository wherever you want.
The bootstrapper script will create symlinks in the home directory to the proper files.
When the git repo is updated, the files will be automatically updated when the session is restarted.

```bash
git clone https://github.com/weikinhuang/dotfiles.git && cd dotfiles && ./bootstrap.sh
```

### Install dotfiles without Git

To source these files, type:

```bash
curl https://raw.github.com/weikinhuang/dotfiles/master/install.sh | sh
```

To update later on, just run that command again, and will create backups to the current files with a *.bak extension.

### Add custom commands

If `~/.bash_local_exports` exists, it will be sourced before the includes are included.
If `~/.bash_local` exists, it will be sourced after the includes are included.

### Custom options for the PS1

Turn off the load indicator (speeds up the cygwin prompt by a bit)
```bash
export _PS1_HIDE_LOAD=1
```
