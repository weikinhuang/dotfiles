" Source the dotfiles vimrc file
if filereadable(expand('~/.vim/.vimrc'))
	source ~/.vim/.vimrc
endif

" source any local vimrc files
if filereadable(expand('~/.vimrc.local'))
	source ~/.vimrc.local
endif
