
# weikinhuang's dotfiles reference

## Changes

`sudo` works on aliases

`rm` `cp` `mv` are always inteactive `-i` (use `-f` to override)

`ls` and `grep` always has color (use `--color=never` to override)

`which` command expands full path when possible

`less` does not clear the screen upon exit and process colors (with options `-XR`)

`diff` uses git's diff command with color when possible

`pbcopy` and `pbpaste` for cross-platform copy/paste from cli

`open` for cross-platform open in native application

`md5` for cross-platform `md5sum`

## New Global Variables

```text
PROC_CORES               => number of threads (cores)
DOTENV                   => Simple access to os platform
```

## All Platforms

### Navigation

```text
..               => cd ..
...              => cd ../..
....             => cd ../../..
~                => cd ~ == cd
-                => cd -
cd --            => List last 10 traversed directories
```

### Directory Commands

```text
la               => Show all files in list format
ll               => Show files in list format
l.               => Show files starting with .
lf               => Show directories in list format

cf               => Count the number of files in a directory
findhere         => Case insensitive find in current directory (find -iname "*arg*")
grip             => Case-insensetive grep on all the files in current directory

md               => Create a new directory and enter it

dusort           => Bar chart of all files and relative size

rename           => Renames files according to modification rules. http://plasmasturm.org/code/rename/
```

### Shortcuts

```text
h                => history
f                => findhere
o                => open (show in GUI file explorer)
oo               => open . (show cwd in GUI file explorer)
-                => cd -
x                => parallel-xargs

p                => cd $PROJECT_DIR
```

## Networking

```text
ips              => Get all bound internal ips
extip            => Get the current external ip address

curl-gz          => Make gzip enabled curl requests
```

### String Manipulation

```text
escape           => Escape UTF-8 characters into their 3-byte format (escape λ => \xCE\xBB)
unidecode        => Decode \x{ABCD}-style Unicode escape sequences
codepoint        => Get a character's Unicode code point

lc               => Convert to lowercase
uc               => Convert to uppercase

regex            => Regex match and replace from: https://gist.github.com/opsb/4409156

json             => Pretty print json output
```

### Utilities

```text
__dotfiles::fn::push_prompt_command => Pushes a new command to the PROMPT_COMMAND variable

extract          => Extracts a archive with autodetect based on extension
gz               => Get the gzipped filesize

dataurl          => Create a data URL from an image
genpasswd        => Generate a random string of a certain length

unix2date        => Convert a unix timestamp to a date string (unix2date 1234567890 => Fri, Feb 13, 2009  6:31:30 PM)
date2unix        => Convert a date string to a unix timestamp (date2unix Fri, Feb 13, 2009  6:31:30 PM => 1234567890)
totime           => date2unix
fromtime         => unix2date

parallel-xargs   => Run a command through xargs with that is sh wrapped (parallel-xargs cat {})

hosts-rebuild    => Build hosts file with dev hosts and ad blocking
```

### Git Utilities

```text
git auto-difftool        => Use araxis merge when possible otherwise use vimdiff
git auto-mergetool       => Use araxis merge when possible otherwise use vimdiff
git branch-prune         => Remove branches locally and remotely if already merged into master
git changelog            => Generate a changelog from git tags
git gh-pages             => Setup a new branch called gh-pages following github procedure
git hooks                => Execute a git hook
git hub-pull-request     => Open a pull request on github
git hub-token            => Generate a github api access token
git ignore               => Add a file/path to .gitignore
git ls-dir               => List files in a git repo tree together with the latest commit
git remove-history       => Permanently delete files/folders from repository
git repl                 => Start a repl where all commands are prefixed with "git"
git touch                => Make a new file and add it
git track                => Sets up auto-tracking of a remote branch with same base name
```

## CYGWIN specific

### Utilities

```text
olib                     => Open a Windows (Vista/7/8) Libraries
psfind                   => Find processes by name match
pskill                   => Kill processes by name match
__cygexewrap             => Give the ability to wrap applications and set up Windows paths (GUI)
__cygcliwrap             => Give the ability to wrap applications and set up Windows paths (CLI)
apt-cyg                  => CLI for cygwin installer https://github.com/transcode-open/apt-cyg
apt-get                  => apt-cyg

docs                     => cd ~/Documents
desk                     => cd ~/Documents/Desktop
dl                       => cd ~/Documents/Downloads
d                        => cd ~/Documents/Dropbox

winpty                   => Provide a proper pty for Windows console apps https://github.com/rprichard/winpty
inotifywait              => FS watcher
chattr                   => Change Windows file attributes
cygsetup                 => Open cygwin setup
lnw                      => Create a windows symlink
npp                      => Open a sandboxed instance of notepad++
rc                       => Send a file to the recycle bin
symlink-reflow           => Convert all symlinks in a directory between cygwin and Windows style

winstart                 => shortcut to `cygstart ...` and makes all file references absolute
s                        => winstart
```

### Global Variables

```text
USERPROFILE              => Path to the windows user profile directory
APPDATA                  => Path to the windows user AppData directory
CYGWIN                   => Cygwin configuration https://cygwin.com/cygwin-ug-net/using-cygwinenv.html
```
