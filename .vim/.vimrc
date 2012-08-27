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
set magic						" For regular expressions turn magic on
set wildmenu					" autocomplete anywhere
set wildmode=list:longest

" This makes vim act like all other editors, buffers can
" exist in the background without being in a window.
set hidden

syntax enable					" synyax highlighting
set ruler						" show ruler
set cursorline					" highlight current line
set cursorcolumn				" highlight the current column

set history=1000				" remember more commands and search history
set undolevels=1000				" use many muchos levels of undo
set title						" change the terminal's title
set noerrorbells				" don't beep
set novisualbell				" don't beep

set encoding=utf8				" Set utf8 as standard encoding and en_US as the standard language
set ffs=unix,dos,mac			" Use Unix as the standard file type

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
set scrolloff=4					" start scrolling when we're 4 lines away from margins
set sidescrolloff=15
set sidescroll=1

" ================ Themes ===========================
" Solarized color scheme
set background=light
colorscheme solarized

" ================ Keyboard remappings ==============
set pastetoggle=<F2>			" Press F2 to enable pastemode and disable auto formatting
nnoremap ; :					" Save a keypress

" window
nmap <leader>sw<left>  :topleft  vnew<CR>
nmap <leader>sw<right> :botright vnew<CR>
nmap <leader>sw<up>    :topleft  new<CR>
nmap <leader>sw<down>  :botright new<CR>
" buffer
nmap <leader>s<left>   :leftabove  vnew<CR>
nmap <leader>s<right>  :rightbelow vnew<CR>
nmap <leader>s<up>     :leftabove  new<CR>
nmap <leader>s<down>   :rightbelow new<CR>

" map simple ctrl keys for split/window movement and sizing
map <C-J> <C-W>j<C-W>_
map <C-K> <C-W>k<C-W>_
map <C-L> <C-W>l<C-W>_
map <C-H> <C-W>h<C-W>_

nnoremap <C-Left> :tabprevious<CR>	" Move to the previous tab
nnoremap <C-Right> :tabnext<CR>		" Move to the next tab

" new tab
map <C-t>n :tabnew<CR>
" close tab
map <C-t>c :tabclose<CR>

" ================ Misc ===================+++=======
if has("autocmd")
	" Restore cursor position
	autocmd BufReadPost * if line("'\"") > 0|if line("'\"") <= line("$")|exe("norm '\"")|else|exe "norm $"|endif|endif

	" Highlight JSON as javascript -- usefull if you don't want to load json.vim
	autocmd BufNewFile,BufRead *.json set ft=javascript

	" Also load indent files, to automatically do language-dependent indenting.
	filetype plugin indent on
endif

" Convenient command to see the difference between the current buffer and the
" file it was loaded from, thus the changes you made.
" Only define it when not defined already.
if !exists(":DiffOrig")
	command DiffOrig vert new | set bt=nofile | r # | 0d_ | diffthis | wincmd p | diffthis
endif

" ================ Plugins ==========================
" ==================== Ctrl+P
set runtimepath^=~/.vim/bundle/ctrlp.vim

" change default behavior to open a tab
let g:ctrlp_prompt_mappings = {
	\ 'AcceptSelection("e")': ['<c-t>'],
	\ 'AcceptSelection("t")': ['<cr>', '<2-LeftMouse>'],
	\ }

" ==================== VIM-powerline
set runtimepath^=~/.vim/bundle/vim-powerline

set laststatus=2				" always show the status line (for vim-powerline)
set t_Co=256					" Tell powerline we're in 265 color mode
" let g:Powerline_symbols='unicode'	" Use unicode symbols for vim-powerline

" ==================== neocomplcache
set runtimepath^=~/.vim/bundle/neocomplcache

" Use neocomplcache.
let g:neocomplcache_enable_at_startup=1
" Use smartcase.
let g:neocomplcache_enable_smart_case = 1
" Use camel case completion.
let g:neocomplcache_enable_camel_case_completion = 1
" Use underbar completion.
let g:neocomplcache_enable_underbar_completion = 1
" Set minimum syntax keyword length.
let g:neocomplcache_min_syntax_length = 2
let g:neocomplcache_lock_buffer_name_pattern = '\*ku\*'

" Enable omni completion.
if has("autocmd")
	autocmd FileType css setlocal omnifunc=csscomplete#CompleteCSS
	autocmd FileType html,markdown setlocal omnifunc=htmlcomplete#CompleteTags
	autocmd FileType javascript setlocal omnifunc=javascriptcomplete#CompleteJS
	autocmd FileType python setlocal omnifunc=pythoncomplete#Complete
	autocmd FileType xml setlocal omnifunc=xmlcomplete#CompleteTags
endif

" ==================== VIM-fugitive
set runtimepath^=~/.vim/bundle/vim-fugitive
