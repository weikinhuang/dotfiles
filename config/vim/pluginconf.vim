" ==============================================================================
" => Plugins
" ==============================================================================

" =====================================
" => vim-airline
" =====================================
" enable powerline fonts
let g:airline_powerline_fonts = 1

" Show tabline
" let g:airline#extensions#tabline#enabled = 1

" Theming options
" Solarized color scheme
if !empty($DOT_SOLARIZED_DARK) || !empty($DOT_SOLARIZED_LIGHT)
  let g:airline_theme='solarized'
endif
set laststatus=2                " always show the status line (for vim-powerline)

" =====================================
" => ale
" =====================================
let g:airline#extensions#ale#enabled = 1

let g:ale_echo_msg_format = '%linter%: %s'
" let g:ale_lint_on_text_changed = 'never'
let g:ale_sign_column_always = 1

let g:ale_linters = {
  \ 'vue': ['eslint', 'stylelint'],
\ }
let g:ale_linter_aliases = {'vue': ['css', 'javascript']}

" =====================================
" => vim-jsx
" =====================================
let g:jsx_ext_required = 0

" =====================================
" => vim-json
" =====================================
let g:vim_json_syntax_conceal = 0
