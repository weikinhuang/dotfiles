local source = debug.getinfo(1, "S").source:sub(2)
local dotfiles_root = vim.fn.fnamemodify(vim.fn.resolve(source), ":p:h")

vim.opt.runtimepath:prepend(dotfiles_root)

local function source_file(path)
  vim.cmd.source(vim.fn.fnameescape(path))
end

source_file(dotfiles_root .. "/vimrc")
source_file(dotfiles_root .. "/mappings.vim")
source_file(dotfiles_root .. "/pluginconf.vim")
source_file(dotfiles_root .. "/filetypes.vim")
source_file(dotfiles_root .. "/autocommands.vim")

require("config.lazy")
