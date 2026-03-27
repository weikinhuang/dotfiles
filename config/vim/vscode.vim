if exists('g:dotfiles_vscode_loaded')
  finish
endif
let g:dotfiles_vscode_loaded = 1

function! s:command_exists(command) abort
  return exists(':' . a:command) == 2
endfunction

function! s:notify(message) abort
  echohl WarningMsg
  echomsg 'dotfiles: ' . a:message
  echohl None
endfunction

function! s:ensure_normal_mode() abort
  if mode() =~# '^[iR]'
    silent! stopinsert
  endif
endfunction

function! s:open_command_prompt(prefix) abort
  call s:ensure_normal_mode()
  call feedkeys(':' . a:prefix, 'n')
endfunction

function! s:quick_open() abort
  if s:command_exists('Files')
    execute 'Files'
    return
  endif

  if s:command_exists('FZF')
    execute 'FZF'
    return
  endif

  call s:notify('Quick open is unavailable because fzf.vim is not loaded')
endfunction

function! s:command_palette() abort
  if s:command_exists('Commands')
    execute 'Commands'
    return
  endif

  if s:command_exists('FZF')
    execute 'FZF'
    return
  endif

  call s:notify('Command palette is unavailable because fzf.vim is not loaded')
endfunction

function! s:write_current_buffer() abort
  call s:ensure_normal_mode()
  write
endfunction

function! s:write_all_buffers() abort
  call s:ensure_normal_mode()
  wall
endfunction

function! s:quit_current_window() abort
  call s:ensure_normal_mode()
  quit
endfunction

function! s:search_current_buffer() abort
  call s:ensure_normal_mode()
  call feedkeys('/', 'n')
endfunction

function! s:toggle_sidebar() abort
  if s:command_exists('NvimTreeToggle')
    execute 'NvimTreeToggle'
    return
  endif

  if s:command_exists('NERDTreeToggle')
    execute 'NERDTreeToggle'
    return
  endif

  call s:notify('Explorer is unavailable')
endfunction

function! s:reveal_active_file() abort
  if s:command_exists('NvimTreeFindFile') && expand('%:p') !=# ''
    execute 'NvimTreeFindFile'
    return
  endif

  if s:command_exists('NvimTreeFocus')
    execute 'NvimTreeFocus'
    return
  endif

  if s:command_exists('NERDTreeFind') && expand('%:p') !=# ''
    execute 'NERDTreeFind'
    return
  endif

  if s:command_exists('NERDTreeFocus')
    execute 'NERDTreeFocus'
    return
  endif

  call s:notify('Explorer is unavailable')
endfunction

function! s:focus_or_toggle_terminal() abort
  if !has('terminal')
    call s:notify('Terminal is unavailable in this Vim build')
    return
  endif

  if &buftype ==# 'terminal'
    silent! stopinsert
    wincmd p
    return
  endif

  for l:winnr in range(1, winnr('$'))
    if getbufvar(winbufnr(l:winnr), '&buftype') ==# 'terminal'
      execute l:winnr . 'wincmd w'
      startinsert
      return
    endif
  endfor

  botright split
  terminal
  startinsert
endfunction

function! s:goto_line() abort
  call s:ensure_normal_mode()

  let l:line = input('Goto line: ')
  if empty(l:line)
    return
  endif

  if l:line !~# '^\d\+$'
    call s:notify('Expected a line number')
    return
  endif

  call cursor(min([str2nr(l:line), line('$')]), 1)
endfunction

function! s:run_ale_command(command, unavailable_message) abort
  call s:ensure_normal_mode()

  if !s:command_exists(a:command)
    call s:notify(a:unavailable_message)
    return
  endif

  execute a:command
endfunction

function! s:run_ale_code_action_visual() range abort
  if !s:command_exists('ALECodeAction')
    call s:notify('Code actions require ALE LSP support')
    return
  endif

  execute a:firstline . ',' . a:lastline . 'ALECodeAction'
endfunction

function! s:duplicate_current_line(where, resume_insert) abort
  let l:row = line('.')
  let l:text = getline(l:row)

  if a:where ==# 'up'
    call append(l:row - 1, l:text)
    call cursor(l:row, 1)
  else
    call append(l:row, l:text)
    call cursor(l:row + 1, 1)
  endif

  if a:resume_insert
    startinsert
  endif
endfunction

function! s:duplicate_selection(where) abort
  let l:start = line("'<")
  let l:end = line("'>")
  let l:lines = getline(l:start, l:end)

  if a:where ==# 'up'
    call append(l:start - 1, l:lines)
  else
    call append(l:end, l:lines)
  endif
endfunction

nnoremap <silent> <C-p> :<C-u>call <SID>quick_open()<CR>
nnoremap <silent> <F1> :<C-u>call <SID>command_palette()<CR>
nnoremap <silent> <C-b> :<C-u>call <SID>toggle_sidebar()<CR>
nnoremap <silent> <C-e> :<C-u>call <SID>reveal_active_file()<CR>
nnoremap <silent> <C-f> :<C-u>call <SID>search_current_buffer()<CR>
inoremap <silent> <C-f> <Esc>:call <SID>search_current_buffer()<CR>
vnoremap <silent> <C-f> <Esc>:call <SID>search_current_buffer()<CR>
nnoremap <silent> <C-s> :<C-u>call <SID>write_current_buffer()<CR>
inoremap <silent> <C-s> <Esc>:call <SID>write_current_buffer()<CR>
vnoremap <silent> <C-s> <Esc>:call <SID>write_current_buffer()<CR>
nnoremap <silent> <C-q> :<C-u>call <SID>quit_current_window()<CR>
inoremap <silent> <C-q> <Esc>:call <SID>quit_current_window()<CR>
vnoremap <silent> <C-q> <Esc>:call <SID>quit_current_window()<CR>
nnoremap <C-h> :<C-u>call <SID>open_command_prompt('Rg ')<CR>
inoremap <C-h> <Esc>:call <SID>open_command_prompt('Rg ')<CR>
nnoremap <silent> <C-g> :<C-u>call <SID>goto_line()<CR>
inoremap <silent> <C-g> <Esc>:call <SID>goto_line()<CR>
nnoremap <silent> <C-l> :<C-u>call <SID>goto_line()<CR>
inoremap <silent> <C-l> <Esc>:call <SID>goto_line()<CR>
nnoremap <silent> <C-]> :bnext<CR>
nnoremap <silent> <A-f> :<C-u>call <SID>run_ale_command('ALEFix', 'Format requires ALE with fixer support')<CR>
inoremap <silent> <A-f> <Esc>:call <SID>run_ale_command('ALEFix', 'Format requires ALE with fixer support')<CR>
nnoremap <silent> <A-r> :<C-u>call <SID>run_ale_command('ALERename', 'Rename requires ALE LSP support')<CR>
inoremap <silent> <A-r> <Esc>:call <SID>run_ale_command('ALERename', 'Rename requires ALE LSP support')<CR>
nnoremap <silent> <F2> :<C-u>call <SID>run_ale_command('ALERename', 'Rename requires ALE LSP support')<CR>
inoremap <silent> <F2> <Esc>:call <SID>run_ale_command('ALERename', 'Rename requires ALE LSP support')<CR>
nnoremap <silent> <F12> :<C-u>call <SID>run_ale_command('ALEGoToDefinition', 'Go to definition requires ALE LSP support')<CR>
nnoremap <silent> <S-F12> :<C-u>call <SID>run_ale_command('ALEFindReferences', 'Find references requires ALE LSP support')<CR>
nnoremap <silent> <C-.> :<C-u>call <SID>run_ale_command('ALECodeAction', 'Code actions require ALE LSP support')<CR>
xnoremap <silent> <C-.> :<C-u>call <SID>run_ale_code_action_visual()<CR>
nnoremap <silent> <C-d> "_dd
inoremap <silent> <C-d> <Esc>"_ddi
xnoremap <silent> <C-d> "_d
nnoremap <silent> <A-j> :m .+1<CR>==
nnoremap <silent> <A-k> :m .-2<CR>==
inoremap <silent> <A-j> <Esc>:m .+1<CR>==gi
inoremap <silent> <A-k> <Esc>:m .-2<CR>==gi
xnoremap <silent> <A-j> :m '>+1<CR>gv=gv
xnoremap <silent> <A-k> :m '<-2<CR>gv=gv
nnoremap <silent> <A-Left> <C-o>
nnoremap <silent> <A-Right> <C-i>
nnoremap <silent> <C-A-Down> :<C-u>call <SID>duplicate_current_line('down', 0)<CR>
nnoremap <silent> <C-A-Up> :<C-u>call <SID>duplicate_current_line('up', 0)<CR>
inoremap <silent> <C-A-Down> <Esc>:call <SID>duplicate_current_line('down', 1)<CR>
inoremap <silent> <C-A-Up> <Esc>:call <SID>duplicate_current_line('up', 1)<CR>
xnoremap <silent> <C-A-Down> :<C-u>call <SID>duplicate_selection('down')<CR>gv
xnoremap <silent> <C-A-Up> :<C-u>call <SID>duplicate_selection('up')<CR>gv
nnoremap <silent> <C-`> :<C-u>call <SID>focus_or_toggle_terminal()<CR>

if has('nvim')
  tnoremap <silent> <C-`> <C-\><C-n>:call <SID>focus_or_toggle_terminal()<CR>
else
  tnoremap <silent> <C-`> <C-W>N:call <SID>focus_or_toggle_terminal()<CR>
endif

if has('mac') || has('macunix')
  nnoremap <silent> <D-p> :<C-u>call <SID>quick_open()<CR>
  nnoremap <silent> <D-b> :<C-u>call <SID>toggle_sidebar()<CR>
  nnoremap <silent> <D-S-e> :<C-u>call <SID>reveal_active_file()<CR>
  nnoremap <silent> <D-f> :<C-u>call <SID>search_current_buffer()<CR>
  inoremap <silent> <D-f> <Esc>:call <SID>search_current_buffer()<CR>
  nnoremap <D-h> :<C-u>call <SID>open_command_prompt('Rg ')<CR>
  inoremap <D-h> <Esc>:call <SID>open_command_prompt('Rg ')<CR>
  nnoremap <silent> <D-d> "_dd
  inoremap <silent> <D-d> <Esc>"_ddi
  xnoremap <silent> <D-d> "_d
  nnoremap <silent> <D-l> :<C-u>call <SID>goto_line()<CR>
  inoremap <silent> <D-l> <Esc>:call <SID>goto_line()<CR>
  nnoremap <silent> <D-y> <C-r>
  nnoremap <silent> <D-]> :bnext<CR>
  nnoremap <silent> <D-[> :bprevious<CR>
  nnoremap <silent> <D-S-r> :<C-u>call <SID>quick_open()<CR>
  nnoremap <silent> <D-S-p> :<C-u>call <SID>command_palette()<CR>
  nnoremap <silent> <D-S-s> :<C-u>call <SID>write_all_buffers()<CR>
  inoremap <silent> <D-S-s> <Esc>:call <SID>write_all_buffers()<CR>
  vnoremap <silent> <D-S-s> <Esc>:call <SID>write_all_buffers()<CR>
  nmap <D-j> <A-j>
  nmap <D-k> <A-k>
  imap <D-j> <A-j>
  imap <D-k> <A-k>
  xmap <D-j> <A-j>
  xmap <D-k> <A-k>
  nnoremap <silent> <D-A-Down> :<C-u>call <SID>duplicate_current_line('down', 0)<CR>
  nnoremap <silent> <D-A-Up> :<C-u>call <SID>duplicate_current_line('up', 0)<CR>
  inoremap <silent> <D-A-Down> <Esc>:call <SID>duplicate_current_line('down', 1)<CR>
  inoremap <silent> <D-A-Up> <Esc>:call <SID>duplicate_current_line('up', 1)<CR>
endif
