" This must be first, because it changes other options as side effect
set nocompatible

set hidden

set nowrap						" don't wrap lines
set tabstop=4					" a tab is four spaces
set noexpandtab					" don't expand tabs into spaces
set backspace=indent,eol,start	" allow backspacing over everything in insert mode
set autoindent					" always set autoindenting on
set copyindent					" copy the previous indentation on autoindenting
set number						" always show line numbers
set shiftwidth=4				" number of spaces to use for autoindenting
set shiftround					" use multiple of shiftwidth when indenting with '<' and '>'
set showmatch					" set show matching parenthesis
set ignorecase					" ignore case when searching
set smartcase					" ignore case if search pattern is all lowercase, case-sensitive otherwise
set smarttab					" insert tabs on the start of a line according to shiftwidth, not tabstop
set hlsearch					" highlight search terms
set incsearch					" show search matches as you type
set wrap						" wrap text
set showcmd						" show previous command

" Enable mouse support
if has('mouse')
	set mouse=a
endif

" Solarized color scheme
set background=light
colorscheme solarized

" Synyax highlighting
syntax enable
" Show ruler & highlight current line
set ruler
set cursorline

set history=1000				" remember more commands and search history
set undolevels=1000				" use many muchos levels of undo
set title						" change the terminal's title
set noerrorbells				" don't beep

" Use more modern methods for temp files
set nobackup
set noswapfile

" traditional grepping with ack
set grepprg=ack

" Include the ctrl+p plugin
set runtimepath^=~/.vim/bundle/ctrlp.vim

" Keyboard remappings
set pastetoggle=<F2>			" Press F2 to enable pastemode and disable auto formatting
" Mousemode shortcuts
if has('mouse')
	map <F11> :set mouse=a<CR>	" Press F11 to enable mousemode
	map <F12> :set mouse-=a<CR>	" Press F12 to disable mousemode
endif
nnoremap ; :







" Plugin options

" Ctrl+P
" change default behavior to open a tab
let g:ctrlp_prompt_mappings = {
	\ 'AcceptSelection("e")': ['<c-t>'],
	\ 'AcceptSelection("t")': ['<cr>', '<2-LeftMouse>'],
	\ }
