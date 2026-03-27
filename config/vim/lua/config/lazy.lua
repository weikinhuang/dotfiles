local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
local config_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")

if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local out = vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "--no-tags",
    "--branch=stable",
    "https://github.com/folke/lazy.nvim.git",
    lazypath,
  })

  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to bootstrap lazy.nvim\n", "ErrorMsg" },
      { out, "WarningMsg" },
    }, true, {})
    return
  end
end

vim.opt.runtimepath:prepend(lazypath)

if not vim.g.dotfiles_lazy_git_env_patched then
  local lazy_process = require("lazy.manage.process")
  local original_spawn = lazy_process.spawn

  lazy_process.spawn = function(cmd, opts)
    opts = opts or {}

    if cmd == "git" then
      opts.env = vim.tbl_extend("force", opts.env or {}, {
        GIT_CONFIG_GLOBAL = "/dev/null",
      })
    end

    return original_spawn(cmd, opts)
  end

  vim.g.dotfiles_lazy_git_env_patched = true
end

require("lazy").setup(require("plugins"), {
  change_detection = {
    notify = false,
  },
  performance = {
    rtp = {
      paths = { config_root },
    },
  },
})
