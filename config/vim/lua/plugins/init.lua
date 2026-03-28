return {
  { "dense-analysis/ale" },
  { "editorconfig/editorconfig-vim" },
  { "godlygeek/tabular" },
  {
    "junegunn/fzf",
    build = function(plugin)
      local install_cmd

      if vim.fn.has("win32") == 1 or vim.fn.has("win64") == 1 then
        local powershell = vim.fn.executable("pwsh") == 1 and "pwsh" or "powershell"
        install_cmd = {
          powershell,
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          plugin.dir .. "/install.ps1",
          "-Bin",
        }
      else
        install_cmd = {
          plugin.dir .. "/install",
          "--bin",
        }
      end

      local out = vim.fn.system(install_cmd)
      if vim.v.shell_error ~= 0 then
        error(out)
      end
    end,
  },
  { "junegunn/fzf.vim" },
  {
    "lifepillar/vim-solarized8",
    lazy = false,
    priority = 1000,
    config = function()
      if vim.env.DOT_SOLARIZED_LIGHT and vim.env.DOT_SOLARIZED_LIGHT ~= "" then
        vim.o.background = "light"
        pcall(vim.cmd.colorscheme, "solarized8")
      elseif vim.env.DOT_SOLARIZED_DARK and vim.env.DOT_SOLARIZED_DARK ~= "" then
        vim.o.background = "dark"
        pcall(vim.cmd.colorscheme, "solarized8")
      end
    end,
  },
  { "mg979/vim-visual-multi", branch = "master" },
  { "tpope/vim-fugitive" },
  { "tpope/vim-sleuth" },
  { "vim-airline/vim-airline" },
  { "vim-airline/vim-airline-themes" },
  { "preservim/vim-markdown" },
  { "github/copilot.vim" },
  { "nvim-tree/nvim-web-devicons" },
  {
    "akinsho/bufferline.nvim",
    version = "*",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    config = function()
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
              text_align = "left",
            },
          },
        },
      })
    end,
  },
  {
    "nvim-tree/nvim-tree.lua",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    config = function()
      local api = require("nvim-tree.api")

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
          api.config.mappings.default_on_attach(bufnr)
          vim.keymap.set("n", "<C-e>", api.tree.toggle, {
            buffer = bufnr,
            noremap = true,
            silent = true,
          })
        end,
      })

      vim.keymap.set("n", "<C-e>", api.tree.toggle, {
        noremap = true,
        silent = true,
      })
    end,
  },
  {
    "lewis6991/gitsigns.nvim",
    config = function()
      require("gitsigns").setup({
        current_line_blame = true,
        current_line_blame_formatter = "    <author>, <author_time:%Y-%m-%d> - <summary>",
      })
    end,
  },
  {
    "lukas-reineke/indent-blankline.nvim",
    main = "ibl",
    config = function()
      require("ibl").setup()
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "master",
    build = ":TSUpdateSync",
    config = function()
      require("nvim-treesitter.configs").setup({
        auto_install = true,
        highlight = {
          enable = true,
        },
      })
    end,
  },
  {
    "numToStr/Comment.nvim",
    config = true,
  },
  {
    "hrsh7th/nvim-cmp",
    dependencies = {
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-path",
    },
    config = function()
      require("config.cmp").setup()
    end,
  },
  {
    "mason-org/mason.nvim",
    opts = {},
  },
  { "neovim/nvim-lspconfig" },
  {
    "mason-org/mason-lspconfig.nvim",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "mason-org/mason.nvim",
      "neovim/nvim-lspconfig",
    },
    config = function()
      require("config.lsp").setup()
    end,
  },
}
