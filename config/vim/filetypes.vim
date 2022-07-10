" ==============================================================================
" => Filetype configuration
" ==============================================================================

" =====================================
" => plaintext
" =====================================
" Assume txt files to be written in markdown, highlight syntax accordingly
autocmd BufRead,BufNewFile *.txt setlocal filetype=markdown

" =====================================
" => ssh config
" =====================================
" SSH config
autocmd BufNewFile,BufRead .ssh/config set filetype=sshconfig
