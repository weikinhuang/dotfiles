" ==============================================================================
" => VIM Plugins
" ==============================================================================

" =====================================
" => NERDTree
" =====================================
" remap nerdtree
map <C-e> :NERDTreeToggle<CR>

" close vim when NERDTree is the only window left
autocmd bufenter * if (winnr("$") == 1 && exists("b:NERDTreeType") && b:NERDTreeType == "primary") | q | endif

" show hidden files (.)
let NERDTreeShowHidden=1

" =====================================
" => indentLine
" =====================================
let g:indentLine_setColors = 1
" Solarized color scheme
" TODO: determine colors
"  if !empty($DOT_SOLARIZED_LIGHT)
"    let g:indentLine_color_term = 7
"  endif
"  if !empty($DOT_SOLARIZED_DARK)
"    let g:indentLine_color_term = 0
"  endif
let g:indentLine_char_list = ['|', '¦', '┆', '┊']
