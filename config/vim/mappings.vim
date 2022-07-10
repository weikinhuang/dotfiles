" ==============================================================================
" => Keyboard remappings
" ==============================================================================
" Save a keypress
nnoremap ; :

" Press F2 to enable pastemode and disable auto formatting
set pastetoggle=<F2>

" Enable mouse support
if has('mouse')
  " Press F11 to enable mousemode
  map <F11> :set mouse=a<CR>
  " Press F12 to disable mousemode
  map <F12> :set mouse-=a<CR>
endif

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

" Tab navigation like in browsers
nnoremap <C-S-tab> :tabprevious<CR>
nnoremap <C-tab>   :tabnext<CR>
nnoremap <C-t>     :tabnew<CR>
inoremap <C-S-tab> <Esc>:tabprevious<CR>i
inoremap <C-tab>   <Esc>:tabnext<CR>i
inoremap <C-t>     <Esc>:tabnew<CR>

" =====================================
" => Mappings to mirror VSCode
" =====================================
" Ctrl+h search all files
map <C-h> :Rg<space>

" Use Ctrl-q for quitting, Ctrl-s for saving
noremap <C-Q> :q<CR>
vnoremap <C-Q> <Esc>:q<CR>
inoremap <C-Q> <Esc>:q<CR>

noremap <silent> <C-S>          :write<CR>
vnoremap <silent> <C-S>         <Esc>:write<CR>
inoremap <silent> <C-S>         <Esc>:write<CR>

" Move a line of text using Alt+[jk] or Command+[jk] on mac
" Unable to bind Alt+<UP/DOWN>
nnoremap <A-j> :m .+1<CR>==
nnoremap <A-k> :m .-2<CR>==
inoremap <A-j> <Esc>:m .+1<CR>==gi
inoremap <A-k> <Esc>:m .-2<CR>==gi
vnoremap <A-j> :m '>+1<CR>gv=gv
vnoremap <A-k> :m '<-2<CR>gv=gv

if has("mac") || has("macunix")
  nnoremap <D-j> <A-j>
  nnoremap <D-k> <A-k>
  inoremap <D-j> <A-j>
  inoremap <D-k> <A-k>
  vnoremap <D-j> <A-j>
  vnoremap <D-k> <A-k>
endif

