" This must be first, because it changes other options as side effect
if !has('nvim')
  set nocompatible
endif

" source plugin configurations
if filereadable(expand('~/.vim.plugins.local'))
  source ~/.vim.plugins.local
elseif filereadable(expand('~/.vim/plugins.vim'))
  source ~/.vim/plugins.vim
elseif filereadable(expand('~/.dotfiles/config/vim/plugins.vim'))
  source ~/.dotfiles/config/vim/plugins.vim
endif

" Source the dotfiles vimrc file
if filereadable(expand('~/.dotfiles/config/vim/vimrc'))
  source ~/.dotfiles/config/vim/vimrc
  source ~/.dotfiles/config/vim/mappings.vim
  " Source the dotfiles nvim config file
  if has('nvim')
    source ~/.dotfiles/config/vim/nvim.vim
  endif
  " Source the dotfiles vim only config file
  if !has('nvim')
    source ~/.dotfiles/config/vim/vim.vim
  endif
  " Configure plugins
  source ~/.dotfiles/config/vim/pluginconf.vim
  source ~/.dotfiles/config/vim/coc.vim
  source ~/.dotfiles/config/vim/filetypes.vim
  source ~/.dotfiles/config/vim/autocommands.vim
endif

" source any local vimrc files
if filereadable(expand('~/.vimrc.local'))
  source ~/.vimrc.local
endif
