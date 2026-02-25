" ==============================================================================
" => neovim Plugins init
" ==============================================================================

" =====================================
" => bufferline
" =====================================
lua << EOF
require("bufferline").setup({
  options = {
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
  sync_root_with_cwd = true,
  update_focused_file = {
    enable = true,
    update_root = false,
  },
  on_attach = function(bufnr)
    local api = require("nvim-tree.api")
    api.config.mappings.default_on_attach(bufnr)
    vim.keymap.set("n", "<C-e>", api.tree.toggle, { buffer = bufnr, noremap = true, silent = true })
  end,
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
require("ibl").setup()
EOF

" =====================================
" => mason + mason-lspconfig
" =====================================
lua << EOF
require("mason").setup()
require("mason-lspconfig").setup({
  automatic_installation = true,
})
EOF

" =====================================
" => nvim-treesitter
" =====================================
" requires curl gcc g++ tar
lua << EOF
require("nvim-treesitter.configs").setup({
  auto_install = true, -- automatically detect which servers to install (based on which servers are set up via lspconfig)
  highlight = {
    enable = true,
  }
})
EOF

" =====================================
" => Comment.nvim
" =====================================
lua << EOF
require("Comment").setup({
})
EOF
