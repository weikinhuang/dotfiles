local uv = vim.uv or vim.loop
local M = {}

function M.may_create_dir()
  local file = vim.fn.expand("<afile>")
  if file == "" or file:match("^%w+://") then
    return
  end

  local dir = vim.fn.fnamemodify(file, ":p:h")
  if vim.fn.isdirectory(dir) == 0 then
    vim.fn.mkdir(dir, "p")
  end
end

local function in_ssh_session()
  return (vim.env.DOT___IS_SSH and vim.env.DOT___IS_SSH ~= "")
    or (vim.env.SSH_CONNECTION and vim.env.SSH_CONNECTION ~= "")
    or (vim.env.SSH_CLIENT and vim.env.SSH_CLIENT ~= "")
    or (vim.env.SSH_TTY and vim.env.SSH_TTY ~= "")
end

local function clipboard_server_socket()
  local socket_path = vim.env.CLIPBOARD_SERVER_SOCK
  if socket_path and socket_path ~= "" then
    return socket_path
  end

  local default_socket = "/tmp/clipboard-server.sock"
  local stat = uv and uv.fs_stat(default_socket) or nil
  if stat and stat.type == "socket" then
    return default_socket
  end

  return nil
end

local function clipboard_server_ping_command()
  if vim.fn.executable("curl") == 0 or vim.fn.executable("pbcopy") == 0 or vim.fn.executable("pbpaste") == 0 then
    return nil
  end

  local port = vim.env.CLIPBOARD_SERVER_PORT
  if port and port ~= "" then
    return {
      "curl",
      "-fsL",
      "--max-time",
      "0.2",
      "-o",
      "/dev/null",
      "http://localhost:" .. port .. "/ping",
    }
  end

  local socket_path = clipboard_server_socket()
  if socket_path then
    return {
      "curl",
      "-fsL",
      "--max-time",
      "0.2",
      "--unix-socket",
      socket_path,
      "-o",
      "/dev/null",
      "http://localhost/ping",
    }
  end

  return nil
end

function M.setup_ssh_clipboard_provider()
  if not in_ssh_session() then
    return
  end

  local ping_command = clipboard_server_ping_command()
  if ping_command == nil then
    return
  end

  vim.fn.system(ping_command)
  if vim.v.shell_error ~= 0 then
    return
  end

  vim.g.clipboard = {
    name = "dotfiles-ssh-clipboard",
    copy = {
      ["+"] = { "pbcopy" },
      ["*"] = { "pbcopy" },
    },
    paste = {
      ["+"] = { "pbpaste" },
      ["*"] = { "pbpaste" },
    },
    cache_enabled = 0,
  }
  vim.g.dotfiles_ssh_clipboard_provider = true
end

return M
