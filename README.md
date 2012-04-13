
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

### The Bash Prompt

<pre>
<b><font color="#808080">[</font></b><font color="#ff0000">exitstatus</font> <font color="#00d787">jobs</font> <font color="#c6c6c6">time</font> <font color="#afffff">load</font> <font color="#ff005f">user</font><b><font color="#808080">@</font></b><font color="#ff8700">host</font> <font color="#afaf00">workdir</font><font color="#00af5f"><#files|filesize></font> <font color="#af5fff">(git info)</font><b><font color="#808080">]</font></b>$
</pre>

The prompt
<pre>
[06:00:00 0.00 user#host ayi<4|2.4Mb> (master %)]$ 
[(E:1) 06:00:00 0.00 user#host ayi<4|2.4Mb> (master %)]$ 
[(E:1) bg:2 06:00:00 0.00 user#host ayi<4|2.4Mb> (master %)]$
</pre>

When on ssh
<pre>
on ssh ------------|
[06:00:00 0.00 user@host ayi<4|2.4Mb> (master %)]$
</pre>

When on screen host is replaced with session name and is underlined.
 
load = cpu% on cygwin
load = 1 min load avg on *nix/osx

### Custom options for the PS1

Turn off the load indicator (speeds up the cygwin prompt by a bit)
```bash
export _PS1_HIDE_LOAD=1
```
