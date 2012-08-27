" This must be first, because it changes other options as side effect
set nocompatible

" ================ General Settings  ================
set backspace=indent,eol,start	" allow backspacing over everything in insert mode
set number						" always show line numbers
set showmatch					" set show matching parenthesis
set wrap						" wrap text
set linebreak					" wrap lines at convenient points
set showbreak=↪					" Arrow wrap character
set showcmd						" show incomplete cmds down the bottom
set showmode					" show current mode down the bottom
set autoread					" reload files changed outside vim

" This makes vim act like all other editors, buffers can
" exist in the background without being in a window.
set hidden

syntax enable					" synyax highlighting
set ruler						" show ruler
set cursorline					" highlight current line

set history=1000				" remember more commands and search history
set undolevels=1000				" use many muchos levels of undo
set title						" change the terminal's title
set noerrorbells				" don't beep

" ================ Search Settings  =================
set ignorecase					" ignore case when searching
set smartcase					" ignore case if search pattern is all lowercase, case-sensitive otherwise
set hlsearch					" highlight search terms
set incsearch					" show search matches as you type
set viminfo='100,f1				" save up to 100 marks, enable capital marks
set grepprg=ack					" traditional grepping with ack

" ================ Turn Off Swap Files ==============
set noswapfile
set nobackup
set nowb

" ================ Persistent Undo ==================
if has('undodir')
	silent !mkdir ~/.vim/backups > /dev/null 2>&1
	set undodir=~/.vim/backups
	set undofile
endif

" ================ Indentation ======================
set tabstop=4					" a tab is four spaces
set noexpandtab					" don't expand tabs into spaces
set autoindent					" always set autoindenting on
set copyindent					" copy the previous indentation on autoindenting
set smarttab					" insert tabs on the start of a line according to shiftwidth, not tabstop
set shiftwidth=4				" number of spaces to use for autoindenting
set shiftround					" use multiple of shiftwidth when indenting with '<' and '>'

" ================ Mouse Support ====================
" Enable mouse support
if has('mouse')
	set mouse=a
	map <F11> :set mouse=a<CR>	" Press F11 to enable mousemode
	map <F12> :set mouse-=a<CR>	" Press F12 to disable mousemode
endif

" ================ Scrolling ========================
set scrolloff=8					" start scrolling when we're 8 lines away from margins
set sidescrolloff=15
set sidescroll=1

" ================ Themes ===========================
" Solarized color scheme
set background=light
colorscheme solarized

" ================ Keyboard remappings ==============
set pastetoggle=<F2>			" Press F2 to enable pastemode and disable auto formatting
nnoremap ; :					" Save a keypress

" ================ Plugins ==========================
" Ctrl+P
set runtimepath^=~/.vim/bundle/ctrlp.vim

" change default behavior to open a tab
let g:ctrlp_prompt_mappings = {
	\ 'AcceptSelection("e")': ['<c-t>'],
	\ 'AcceptSelection("t")': ['<cr>', '<2-LeftMouse>'],
	\ }

" VIM-powerline
set runtimepath^=~/.vim/bundle/vim-powerline

set laststatus=2				" always show the status line (for vim-powerline)
set t_Co=256					" Tell powerline we're in 265 color mode
let g:Powerline_symbols='unicode'	" Use unicode symbols for vim-powerline
