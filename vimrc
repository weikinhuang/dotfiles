" source plugin configurations
if filereadable(expand('~/.vim.vundle.local'))
  source ~/.vim.vundle.local
elseif filereadable(expand('~/.vim/vim.vundle'))
  source ~/.vim/vim.vundle
endif

" Source the dotfiles vimrc file
if filereadable(expand('~/.vim/vimrc'))
  source ~/.vim/vimrc
endif

" source any local vimrc files
if filereadable(expand('~/.vimrc.local'))
  source ~/.vimrc.local
endif
