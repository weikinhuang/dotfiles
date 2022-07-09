" ==============================================================================
" => neovim Plugins init
" ==============================================================================

" =====================================
" => bufferline
" =====================================
lua << EOF
require("bufferline").setup({
  show_tab_indicators = true,
  enforce_regular_tabs = false,
  always_show_bufferline = true,
  offsets = {
    {
      filetype = "NvimTree",
      text = function()
        return vim.fn.getcwd()
      end,
      highlight = "Directory",
      text_align = "left"
    }
  }
})
EOF

" =====================================
" => nvim-tree
" =====================================
lua << EOF
require("nvim-tree").setup({
  filters = {
    dotfiles = false,
  },
  disable_netrw = true,
  hijack_netrw = true,
  hijack_cursor = true,
  hijack_unnamed_buffer_when_opening = false,
  update_cwd = true,
  update_focused_file = {
    enable = true,
    update_cwd = false,
  },
  view = {
    mappings = {
      list = {
        { key = "<C-e>", action = "NvimTreeToggle" }
      }
    }
  }
})
EOF

" remap nerdtree
map <C-e> :NvimTreeToggle<CR>

" Close neovim when nvim-tree is the last window
let g:lua_tree_auto_close = 1

" =====================================
" => gitsigns.nvim
" =====================================
lua << EOF
require("gitsigns").setup({
  current_line_blame = true,
  current_line_blame_formatter = '    <author>, <author_time:%Y-%m-%d> - <summary>',
})
EOF

" =====================================
" => Indent Blankline
" =====================================
lua << EOF
require("indent_blankline").setup({
  show_current_context = true,
  show_current_context_start = true,
})
EOF
