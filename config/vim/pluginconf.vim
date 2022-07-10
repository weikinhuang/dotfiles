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
" Integrate with airline
let g:airline#extensions#ale#enabled = 1

"  let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '⬥ ok']

let g:ale_echo_msg_format = '%linter%: %s'
" let g:ale_lint_on_text_changed = 'never'
let g:ale_sign_column_always = 1

" Use coc to provide completion
let g:ale_disable_lsp = 1

" disabling highlighting
"  let g:ale_set_highlights = 0

let g:ale_linters = {
\   'vue': ['eslint', 'vls'],
\ }
let g:ale_linter_aliases = {
\   'vue': ['vue', 'javascript'],
\ }

" =====================================
" => fzf
" =====================================
" Remap Ctrl+P to fzf
nnoremap <C-p> :FZF<cr>

" [Buffers] Jump to the existing window if possible
let g:fzf_buffers_jump = 1

" [[B]Commits] Customize the options used by 'git log':
let g:fzf_commits_log_options = '--graph --color=always --format="%C(auto)%h%d %s %C(black)%C(bold)%cr"'

" [Tags] Command to generate tags file
let g:fzf_tags_command = 'ctags -R'

" [Commands] --expect expression for directly executing the command
let g:fzf_commands_expect = 'alt-enter,ctrl-x'

" Mapping selecting mappings
nmap <leader><tab> <plug>(fzf-maps-n)
xmap <leader><tab> <plug>(fzf-maps-x)
omap <leader><tab> <plug>(fzf-maps-o)

" Insert mode completion
imap <c-x><c-k> <plug>(fzf-complete-word)
imap <c-x><c-f> <plug>(fzf-complete-path)
imap <c-x><c-l> <plug>(fzf-complete-line)
