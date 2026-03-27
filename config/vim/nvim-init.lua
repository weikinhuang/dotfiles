local source = debug.getinfo(1, "S").source:sub(2)
local dotfiles_root = vim.fn.fnamemodify(vim.fn.resolve(source), ":p:h")

vim.opt.runtimepath:prepend(dotfiles_root)
require("utils").setup_ssh_clipboard_provider()

local function source_file(path)
  vim.cmd.source(vim.fn.fnameescape(path))
end

source_file(dotfiles_root .. "/vimrc")
source_file(dotfiles_root .. "/mappings.vim")
source_file(dotfiles_root .. "/pluginconf.vim")
source_file(dotfiles_root .. "/vscode.vim")
source_file(dotfiles_root .. "/filetypes.vim")
source_file(dotfiles_root .. "/autocommands.vim")

if vim.g.dotfiles_ssh_clipboard_provider and not vim.o.clipboard:match("(^|,)unnamedplus(,|$)") then
  vim.opt.clipboard:append("unnamedplus")
end

require("config.lazy")
require("config.vscode").setup()
