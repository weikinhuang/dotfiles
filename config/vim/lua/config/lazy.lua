if vim.fn.has("nvim-0.10") ~= 1 then
  return
end

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
local config_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
local uv = vim.uv or vim.loop
local is_windows = vim.fn.has("win32") == 1 or vim.fn.has("win64") == 1
local git_null_device = is_windows and "NUL" or "/dev/null"
local path_sep = package.config:sub(1, 1)

local function with_sanitized_git_env(fn)
  local git_config_global = vim.env.GIT_CONFIG_GLOBAL
  local git_config_nosystem = vim.env.GIT_CONFIG_NOSYSTEM

  vim.env.GIT_CONFIG_GLOBAL = git_null_device
  vim.env.GIT_CONFIG_NOSYSTEM = "1"

  local ok, result = pcall(fn)

  vim.env.GIT_CONFIG_GLOBAL = git_config_global
  vim.env.GIT_CONFIG_NOSYSTEM = git_config_nosystem

  if not ok then
    error(result)
  end

  return result
end

local function cleanup_treesitter_temp_dirs()
  local cache_root = vim.fn.stdpath("data")
  local scan = uv.fs_scandir(cache_root)

  if not scan then
    return
  end

  while true do
    local name, entry_type = uv.fs_scandir_next(scan)

    if not name then
      break
    end

    -- Async parser updates can leave stale temp directories behind, which
    -- blocks later installs for repos shared across multiple parsers.
    if entry_type == "directory" and name:match("^tree%-sitter%-.+%-tmp$") then
      vim.fn.delete(cache_root .. path_sep .. name, "rf")
    end
  end
end

if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local out = with_sanitized_git_env(function()
    return vim.fn.system({
      "git",
      "clone",
      "--filter=blob:none",
      "--branch=stable",
      "https://github.com/folke/lazy.nvim.git",
      lazypath,
    })
  end)

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
        GIT_CONFIG_GLOBAL = git_null_device,
        GIT_CONFIG_NOSYSTEM = "1",
      })
    end

    return original_spawn(cmd, opts)
  end

  vim.g.dotfiles_lazy_git_env_patched = true
end

cleanup_treesitter_temp_dirs()

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
