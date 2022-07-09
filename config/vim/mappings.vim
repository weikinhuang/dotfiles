" ==============================================================================
" => Keyboard remappings
" ==============================================================================
set pastetoggle=<F2>              " Press F2 to enable pastemode and disable auto formatting
nnoremap ; :                      " Save a keypress

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

nnoremap <C-Left> :tabprevious<CR>     " Move to the previous tab
nnoremap <C-Right> :tabnext<CR>        " Move to the next tab

" new tab
map <C-t>n :tabnew<CR>
" close tab
map <C-t>c :tabclose<CR>
