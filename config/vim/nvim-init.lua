local source = debug.getinfo(1, "S").source:sub(2)
local dotfiles_root = vim.fn.fnamemodify(vim.fn.resolve(source), ":p:h")

vim.opt.runtimepath:prepend(dotfiles_root)
require("utils").setup_ssh_clipboard_provider()

local function source_file(path)
  vim.cmd.source(vim.fn.fnameescape(path))
end

-- lazy.nvim v11+ requires Neovim >= 0.10; fall back to vim-plug on older versions
local use_lazy = vim.fn.has("nvim-0.10") == 1

if not use_lazy then
  source_file(dotfiles_root .. "/plugins.vim")
end

source_file(dotfiles_root .. "/vimrc")
source_file(dotfiles_root .. "/mappings.vim")
if not use_lazy then
  source_file(dotfiles_root .. "/vim.vim")
end
source_file(dotfiles_root .. "/pluginconf.vim")
source_file(dotfiles_root .. "/vscode.vim")
source_file(dotfiles_root .. "/filetypes.vim")
source_file(dotfiles_root .. "/autocommands.vim")

if vim.g.dotfiles_ssh_clipboard_provider and not vim.o.clipboard:match("(^|,)unnamedplus(,|$)") then
  vim.opt.clipboard:append("unnamedplus")
end

if use_lazy then
  require("config.lazy")
end
require("config.vscode").setup()
