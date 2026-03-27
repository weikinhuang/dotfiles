" make sure vim-plug is installed first
if !has('nvim')
  set nocompatible
endif

" Install vim plug automatically
let data_dir = has('nvim') ? stdpath('data') . '/site' : '~/.vim'
if empty(glob(data_dir . '/autoload/plug.vim'))
  silent execute '!curl -fLo '.data_dir.'/autoload/plug.vim --create-dirs  https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif

" install into common dir
call plug#begin('~/.vim/bundle')

Plug 'dense-analysis/ale'
Plug 'editorconfig/editorconfig-vim'
Plug 'godlygeek/tabular'
Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
Plug 'lifepillar/vim-solarized8'
Plug 'mg979/vim-visual-multi', { 'branch': 'master' }
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-sleuth'
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'

" syntax plugins
Plug 'preservim/vim-markdown'

" ==============================================================================
" => Editor specific plugins
" https://github.com/junegunn/vim-plug/wiki/tips#conditional-activation
" ==============================================================================
" =====================================
" => vim only plugins
" =====================================
Plug 'airblade/vim-gitgutter'
Plug 'ekalinin/Dockerfile.vim'
Plug 'preservim/nerdtree'
Plug 'sheerun/vim-polyglot'
Plug 'Xuyuanp/nerdtree-git-plugin'
Plug 'Yggdroot/indentLine'

" All of your Plugins must be added before the following line
call plug#end()              " Initialize plugin system
"endif
