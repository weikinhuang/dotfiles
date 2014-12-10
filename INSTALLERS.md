
# weikinhuang's dotfiles installers

## All platforms

To check what can be installed with this environment
```bash
~/.dotenv/other/dev-check.sh
```

Currently included: `ack`, `youtube-dl`

## Windows/cygwin

Install cygwin (2 step)

Download install script: [/dotenv/other/setup-cygwin.cmd](https://raw.githubusercontent.com/weikinhuang/dotfiles/master/dotenv/other/setup-cygwin.cmd) and run as administrator.

To check what can be installed with this environment
```bash
~/.dotenv/other/dev-check.sh
```

Currently included: `apt-cyg`, `ffmpeg`, `mongodb`, `nodejs`, `php`, `redis`

## OSX

Installing homebrew
```bash
ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
```

Installing core utilties
```bash
# Install GNU core utilities (those that come with OS X are outdated)
brew install coreutils

# Install GNU `find`, `locate`, `updatedb`, and `xargs`, g-prefixed
brew install findutils

# Install Bash 4
brew install bash bash-completion

# Install git
brew install git

# Install wget with IRI support
brew install wget --enable-iri
```

Use the `brew` to install most applications, otherwise:

To check what can be installed with this environment (after installing above)
```bash
~/.dotenv/other/dev-check.sh
```

Currently included: Coming soon

## Linux

Use the standard package manager to install most applications

To check what can be installed with this environment (after installing above)
```bash
~/.dotenv/other/dev-check.sh
```

Currently included: Coming soon
