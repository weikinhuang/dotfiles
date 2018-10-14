# OSX misc files

### Fix `HOME` and `END` keys

Force the `HOME` and `END` keys to have the same behavior as on other platforms

```bash
mkdir -p ~/Library/KeyBindings
cp ~/.dotfiles/utils/darwin/DefaultKeyBindings.dict ~/Library/KeyBindings/
OR
ln -sf ~/.dotfiles/utils/darwin/DefaultKeyBinding.dict ~/Library/KeyBindings/DefaultKeyBinding.dict
```
