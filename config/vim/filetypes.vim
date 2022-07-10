" ==============================================================================
" => Filetype configuration
" ==============================================================================

" =====================================
" => javascript
" =====================================
autocmd BufRead *.jsx set filetype=javascript.jsx

" =====================================
" => markdown
" =====================================
autocmd BufNewFile,BufReadPost *.md set filetype=markdown
autocmd BufNewFile,BufReadPost README set filetype=markdown
autocmd BufNewFile,BufReadPost Readme set filetype=markdown

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

" =====================================
" => typescript
" =====================================
autocmd BufRead *.tsx set filetype=typescript.tsx
