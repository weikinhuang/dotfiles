# macOS setup

## Install the base command line tools

### Install Xcode Command Line Tools

This provides core tooling such as `clang`, `git`, and `make`.

```bash
xcode-select --install
```

To print the install path:

```bash
xcode-select --print-path
# /Library/Developer/CommandLineTools
```

Verify the install with:

```bash
git --version
```

### Install Homebrew

See [brew.sh](https://brew.sh/) for the latest installer and support policy.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Homebrew prints a required post-install step to add `brew` to your shell config.
If you skip it, `brew` will not work in new shells. For Bash, that is typically:

```bash
# Apple Silicon
echo 'eval "$(/opt/homebrew/bin/brew shellenv bash)"' >> ~/.bash_profile
eval "$(/opt/homebrew/bin/brew shellenv bash)"

# Intel
echo 'eval "$(/usr/local/bin/brew shellenv bash)"' >> ~/.bash_profile
eval "$(/usr/local/bin/brew shellenv bash)"
```

## Install useful utilities

A [`Brewfile`](../../Brewfile) is included in the repo with all recommended packages. Install everything at once with:

```bash
brew bundle --file=~/.dotfiles/Brewfile
```

Or install a subset manually:

```bash
brew install bash bash-completion@2 coreutils findutils git vim neovim
```

## Change the default shell

macOS defaults to `zsh`. If you want to use the Homebrew Bash from this repo as
your login shell, it must be listed in `/etc/shells` first.

```bash
brew_bash="$(brew --prefix)/bin/bash"
grep -qxF "$brew_bash" /etc/shells || echo "$brew_bash" | sudo tee -a /etc/shells
chsh -s "$brew_bash"
```

## Other tweaks

### System settings

Tips adapted from [mathiasbynens/dotfiles](https://github.com/mathiasbynens/dotfiles/blob/main/.macos).

```bash
# Disable automatic termination of inactive apps
defaults write NSGlobalDomain NSDisableAutomaticTermination -bool true

# Disable automatic capitalization as it is annoying when typing code
defaults write NSGlobalDomain NSAutomaticCapitalizationEnabled -bool false
# Disable smart dashes as they are annoying when typing code
defaults write NSGlobalDomain NSAutomaticDashSubstitutionEnabled -bool false
# Disable automatic period substitution as it is annoying when typing code
defaults write NSGlobalDomain NSAutomaticPeriodSubstitutionEnabled -bool false
# Disable smart quotes as they are annoying when typing code
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

Force the `HOME` and `END` keys to behave more like other platforms:

```bash
mkdir -p ~/Library/KeyBindings

# Copy once
cp ~/.dotfiles/utils/darwin/DefaultKeyBinding.dict ~/Library/KeyBindings/DefaultKeyBinding.dict

# Or keep it symlinked to the repo checkout
ln -sf ~/.dotfiles/utils/darwin/DefaultKeyBinding.dict ~/Library/KeyBindings/DefaultKeyBinding.dict
```
