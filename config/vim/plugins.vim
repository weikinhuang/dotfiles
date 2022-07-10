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
Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
Plug 'lifepillar/vim-solarized8'
Plug 'Shougo/neocomplete.vim'
Plug 'tpope/vim-fugitive'
Plug 'vim-airline/vim-airline-themes'
Plug 'vim-airline/vim-airline'

" syntax plugins
Plug 'cakebaker/scss-syntax.vim'
Plug 'ekalinin/Dockerfile.vim'
Plug 'elzr/vim-json'
Plug 'fatih/vim-go'
Plug 'groenewege/vim-less'
Plug 'JulesWang/css.vim'
Plug 'leafgarland/typescript-vim'
Plug 'mitsuhiko/vim-python-combined'
Plug 'moll/vim-node'
Plug 'mustache/vim-mustache-handlebars'
Plug 'mxw/vim-jsx'
Plug 'othree/html5.vim'
Plug 'pangloss/vim-javascript'
Plug 'plasticboy/vim-markdown'
Plug 'posva/vim-vue'
Plug 'StanAngeloff/php.vim'
Plug 'vim-ruby/vim-ruby'


" ==============================================================================
" => Editor specific plugins
" https://github.com/junegunn/vim-plug/wiki/tips#conditional-activation
" ==============================================================================
" =====================================
" => vim only plugins
" =====================================
Plug 'airblade/vim-gitgutter', !has('nvim') ? {} : { 'on': [] }
Plug 'preservim/nerdtree', !has('nvim') ? {} : { 'on': [] }
Plug 'Xuyuanp/nerdtree-git-plugin', !has('nvim') ? {} : { 'on': [] }
Plug 'Yggdroot/indentLine', !has('nvim') ? {} : { 'on': [] }

" =====================================
" => neovim only plugins
" =====================================
Plug 'kyazdani42/nvim-web-devicons', has('nvim') ? {} : { 'on': [] } " Recommended (for coloured icons)
Plug 'akinsho/bufferline.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'kyazdani42/nvim-tree.lua', has('nvim') ? {} : { 'on': [] }
Plug 'lewis6991/gitsigns.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'lukas-reineke/indent-blankline.nvim', has('nvim') ? {} : { 'on': [] }
Plug 'nvim-treesitter/nvim-treesitter', has('nvim') ? {} : { 'on': [] }
Plug 'neovim/nvim-lspconfig', has('nvim') ? {} : { 'on': [] }

" All of your Plugins must be added before the following line
call plug#end()              " Initialize plugin system
"endif
