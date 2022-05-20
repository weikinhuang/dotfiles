# MacOS setup

## Install the base command line tools

### Install Xcode Command Line Tools

This is needed as it contains base tooling like `gcc`, `git`, and `make`.

```bash
xcode-select --install
```

To get the path to the cli tools:

```bash
xcode-select --print-path
# /Library/Developer/CommandLineTools
```

Verify the install with:

```bash
git --version
```

### Install homebrew

See [brew.sh](https://brew.sh/) for the latest instructions.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

## Install useful utilities

```bash
brew install \
  bash \
  bash-completion@2 \
  binutils \
  ca-certificates \
  coreutils \
  curl \
  diffutils \
  direnv \
  findutils \
  git \
  git-lfs \
  gnu-tar \
  gnupg \
  gnutls \
  grep \
  htop \
  jq \
  less \
  moreutils \
  nmap \
  openssh \
  screen \
  socat \
  wget
```

Install `vim` with system override

```bash
brew install vim --with-override-system-vi
```

## Change the default $SHELL

Any new shell must exist in `/etc/shells`.

```bash
$ cat /etc/shells
# List of acceptable shells for chpass(1).
# Ftpd will not allow users to connect who are not using
# one of these shells.

/bin/bash
/bin/csh
/bin/ksh
/bin/sh
/bin/tcsh
/bin/zsh
```

Find the path to the shell you want to use, then append it to the file:

```bash
$ sudo vi /etc/shells
.
.
.
/bin/tcsh
/bin/zsh
/usr/local/bin/bash # <--- path to the new shell
```

Then change the default login shell current user:

```bash
chsh -s /usr/local/bin/bash
```

Single command for brew bash

```bash
# Switch to using brew-installed bash as default shell
if ! grep -q "$(brew --prefix)/bin/bash" /etc/shells; then
  echo "$(brew --prefix)/bin/bash" | sudo tee -a /etc/shells
  chsh -s "$(brew --prefix)/bin/bash"
fi;
```

## Other tweaks

### System settings

Tips from [mathiasbynens/dotfiles](https://github.com/mathiasbynens/dotfiles/blob/main/.macos).

```bash
# Disable automatic termination of inactive apps
defaults write NSGlobalDomain NSDisableAutomaticTermination -bool true

# Disable automatic capitalization as it’s annoying when typing code
defaults write NSGlobalDomain NSAutomaticCapitalizationEnabled -bool false
# Disable smart dashes as they’re annoying when typing code
defaults write NSGlobalDomain NSAutomaticDashSubstitutionEnabled -bool false
# Disable automatic period substitution as it’s annoying when typing code
defaults write NSGlobalDomain NSAutomaticPeriodSubstitutionEnabled -bool false
# Disable smart quotes as they’re annoying when typing code
defaults write NSGlobalDomain NSAutomaticQuoteSubstitutionEnabled -bool false

# Trackpad: map bottom right corner to right-click
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadCornerSecondaryClick -int 2
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadRightClick -bool true
defaults -currentHost write NSGlobalDomain com.apple.trackpad.trackpadCornerClickBehavior -int 1
defaults -currentHost write NSGlobalDomain com.apple.trackpad.enableSecondaryClick -bool true

# Disable press-and-hold for keys in favor of key repeat
defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

# Disable subpixel font rendering on non-Apple LCDs
# Reference: https://tonsky.me/blog/monitors/
defaults write NSGlobalDomain AppleFontSmoothing -int 0
# OR
defaults write -g CGFontRenderingFontSmoothingDisabled -bool false

# Finder: show all filename extensions
defaults write NSGlobalDomain AppleShowAllExtensions -bool true
```

### Fix `HOME` and `END` keys

Force the `HOME` and `END` keys to have the same behavior as on other platforms

```bash
mkdir -p ~/Library/KeyBindings
cp ~/.dotfiles/utils/darwin/DefaultKeyBindings.dict ~/Library/KeyBindings/
OR
ln -sf ~/.dotfiles/utils/darwin/DefaultKeyBinding.dict ~/Library/KeyBindings/DefaultKeyBinding.dict
```
