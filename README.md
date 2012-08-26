
# weikinhuang's dotfiles

## Installation

### Install dotfiles with Git

You can clone the repository wherever you want, the home directory is recommended.

The bootstrapper script will create symlinks in the home directory to the proper files.

When the git repo is updated, the files will be automatically updated when the session is restarted.

```bash
cd; git clone https://github.com/weikinhuang/dotfiles.git .dotfiles && cd .dotfiles && ./bootstrap.sh
```

To update later on, just run `git pull` in `~/.dotfiles`.

### Install dotfiles without Git

To source these files, type:

```bash
cd; mkdir ~/.dotfiles 2> /dev/null && curl -#L https://github.com/weikinhuang/dotfiles/tarball/master | tar -C ~/.dotfiles -xzv --strip-components 1 && cd ~/.dotfiles && ./bootstrap.sh
```

To update later on, just run that command again, and will create backups to the current files with a *.bak extension.

### Additional options

Including .gitconfig in the setup with the `--git` options in the bootstrap

```bash
cd; git clone https://github.com/weikinhuang/dotfiles.git .dotfiles && cd .dotfiles && ./bootstrap.sh --git
```

Including .vim and .vimrc in the setup with the `--vim` options in the bootstrap

```bash
cd; git clone https://github.com/weikinhuang/dotfiles.git .dotfiles && cd .dotfiles && ./bootstrap.sh --vim
```

Including all options

```bash
cd; git clone https://github.com/weikinhuang/dotfiles.git .dotfiles && cd .dotfiles && ./bootstrap.sh --vim --git
```

### Add custom commands

If `~/.bash_local_exports` exists, it will be sourced before the includes are sourced.

If `~/.bash_local` exists, it will be sourced after the includes are sourced.

## The Bash Prompt

```bash
[exitstatus jobs time load user@host workdir<dirinfo> (git info)]user symbol
```

The prompt
```bash
[06:00:00 0.00 user#host dir<4|2.4Mb> (master %)]λ 
[(E:1) 06:00:00 0.00 user#host dir<4|2.4Mb> (master %)]λ 
[(E:1) bg:2 06:00:00 0.00 user#host dir<4|2.4Mb> (master %)]λ 
```

When on ssh
```bash
on ssh ------------┐
[06:00:00 0.00 user@host dir<4|2.4Mb> (master %)]λ 
```

When logged in as root user
```bash
as root -----------------------------------------┐
[06:00:00 0.00 root@host dir<4|2.4Mb> (master %)]μ 
```

When sudo'd
```bash
as sudo ----------------┐
[06:00:00 user@host dir]π 
```

When on screen
```bash
in screen [screen name] -----------┐
[06:00:00 0.00 user@12345.pts-01.host01 dir<4|2.4Mb> (master %)]λ 
```

PS2 prompt
```bash
[06:00:00 0.00 user#host dir<4|2.4Mb> (master %)]λ a '\
→ bcd'
```

When on screen host is replaced with session name and is underlined.
 
load = cpu% on cygwin

load = 1 min load avg on *nix/osx

### Custom options for the PS1

Place these options in `~/.bash_local_exports`

Turn off the load indicator (speeds up the cygwin prompt by a bit)
```bash
export _PS1_HIDE_LOAD=1
```

Turn off the directory info
```bash
export _PS1_HIDE_DIR_INFO=1
```

Monochrome prompt
```bash
export _PS1_MONOCHROME=1
```

### The MySQL client Prompt

```
user@host [database]→ 
```

### The Mongo client Prompt

```
host[database]> 
state[repl]#host [database]> 
```

## .gitconfig

If using the gitconfig included in this repository, it is recommended that the user specific configurations be included in environment variables in `~/.bash_local_exports` for portability.
```bash
# git based configurations for portable .gitconfig
export GIT_AUTHOR_NAME=""
export GIT_AUTHOR_EMAIL=""
export GIT_HUB_API_TOKEN=""
```

```bash
cd; ln -s ~/.dotfiles/.gitconfig
```
