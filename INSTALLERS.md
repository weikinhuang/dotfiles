
# weikinhuang's dotfiles installers

## All platforms

Installing ack to `~/bin`
```bash
~/.dotenv/other/install-ack-all.sh
```

Installing youtube-dl to `~/bin`
```bash
~/.dotenv/other/install-youtube-dl-all.sh
```

## Windows/cygwin

Install cygwin (2 step)

Download install script: [/dotenv/other/setup-cygwin.cmd](https://raw.githubusercontent.com/weikinhuang/dotfiles/master/dotenv/other/setup-cygwin.cmd) and run as administrator.

Installing php on windows (global install)
```bash
~/.dotenv/other/install-php-windows.sh
```

Installing nodejs on windows (global install)
```bash
~/.dotenv/other/install-nodejs-windows.sh
```

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

## Linux

