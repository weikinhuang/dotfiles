
# weikinhuang's dotfiles reference

## all platforms

### Changes

`sudo` works on aliases

`rm` `cp` `mv` are always inteactive (use `-f` to override)

`ls` and `grep` always has color (use `--color=never` to override)

`which` command expands full path when possible

`less` does not clear the screen upon exit and process colors (with options `-XR`)

`diff` uses git's diff command with color when possible

### Navigation

```bash
..               => cd ..
...              => cd ../..
....             => cd ../../..
~                => cd ~ == cd
-                => cd -
cd --            => List last 10 traversed directories
```

### Directory Commands

```bash
la               => Show all files in list format
ll               => Show files in list format
l.               => Show files starting with .
lf               => Show directories in list format

cf               => Count the number of files in a directory
findhere         => Case insensitive find in current directory (find -iname "*arg*")
grip             => Case-insensetive grep on all the files in current directory

md               => Create a new directory and enter it
```

### Shortcuts

```bash
h                => history
f                => findhere
o                => open (show in GUI file explorer)
oo               => open . (show cwd in GUI file explorer)
-                => cd -
x                => parallel-xargs
```

## Networking

```bash
extip            => Get the current external ip address

gcurl            => Make gzip enabled curl requests

make "rest" requests
GET              => Make a GET request
HEAD             => Make a HEAD request
POST             => Make a POST request
PUT              => Make a PUT request
DELETE           => Make a DELETE request
TRACE            => Make a TRACE request
OPTIONS          => Make a OPTIONS request
hGET             => Make a GET request and just show headers
hHEAD            => Make a HEAD request and just show headers
hPOST            => Make a POST request and just show headers
hPUT             => Make a PUT request and just show headers
hDELETE          => Make a DELETE request and just show headers
hTRACE           => Make a TRACE request and just show headers
hOPTIONS         => Make a OPTIONS request and just show headers
```

### String Manipulation

```bash
escape           => Escape UTF-8 characters into their 3-byte format (escape λ => \xCE\xBB)
unidecode        => Decode \x{ABCD}-style Unicode escape sequences
codepoint        => Get a character’s Unicode code point

lc               => Convert to lowercase
uc               => Convert to uppercase

regex            => Regex match and replace from: https://gist.github.com/opsb/4409156
```

### Utilities

```bash
__push_prompt_command => Pushes a new command to the PROMPT_COMMAND variable

extract          => Extracts a archive with autodetect based on extension
gz               => Get the gzip'ed filesize

dataurl          => Create a data URL from an image

unix2date        => Convert a unix timestamp to a date string (unix2date 1234567890 => Fri, Feb 13, 2009  6:31:30 PM)
date2unix        => Convert a date string to a unix timestamp (date2unix Fri, Feb 13, 2009  6:31:30 PM => 1234567890)
totime           => date2unix
fromtime         => unix2date

parallel-xargs   => Run a command through xargs with that is sh wrapped (parallel-xargs cat {})
```
