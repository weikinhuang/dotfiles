" make sure vundle is installed first
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
Plug 'neoclide/coc.nvim', { 'branch': 'release' }
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
Plug 'airblade/vim-gitgutter', !has('nvim') ? {} : { 'on': [] }
Plug 'ekalinin/Dockerfile.vim', !has('nvim') ? {} : { 'on': [] }
Plug 'preservim/nerdtree', !has('nvim') ? {} : { 'on': [] }
Plug 'sheerun/vim-polyglot', !has('nvim') ? {} : { 'on': [] }
Plug 'Xuyuanp/nerdtree-git-plugin', !has('nvim') ? {} : { 'on': [] }
Plug 'Yggdroot/indentLine', !has('nvim') ? {} : { 'on': [] }

" =====================================
" => neovim only plugins
" =====================================
Plug 'akinsho/bufferline.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'github/copilot.vim', has('nvim') ? {} : { 'on': [] }
Plug 'kyazdani42/nvim-tree.lua', has('nvim') ? {} : { 'on': [] }
Plug 'kyazdani42/nvim-web-devicons', has('nvim') ? {} : { 'on': [] } " Recommended (for coloured icons)
Plug 'lewis6991/gitsigns.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'lukas-reineke/indent-blankline.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'neovim/nvim-lspconfig', has('nvim') ? {} : { 'on': [] }
Plug 'numToStr/Comment.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'nvim-treesitter/nvim-treesitter', has('nvim') ? {'do': ':TSUpdate'} : { 'on': [] }
Plug 'williamboman/nvim-lsp-installer', has('nvim') ? {} : { 'on': [] }

" All of your Plugins must be added before the following line
call plug#end()              " Initialize plugin system
"endif
