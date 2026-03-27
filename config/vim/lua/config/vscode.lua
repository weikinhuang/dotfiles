local M = {}

local function map(mode, lhs, rhs, desc, opts)
  opts = vim.tbl_extend("force", {
    silent = true,
    desc = desc,
  }, opts or {})

  vim.keymap.set(mode, lhs, rhs, opts)
end

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.WARN, {
    title = "dotfiles",
  })
end

local function ensure_normal_mode()
  if vim.fn.mode():match("^[iR]") then
    vim.cmd("stopinsert")
  end
end

local function lsp_supports(method)
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = 0 })) do
    if client.supports_method and client:supports_method(method) then
      return true
    end
  end

  return false
end

local function rename_symbol()
  ensure_normal_mode()

  if not lsp_supports("textDocument/rename") then
    notify("Rename requires an attached LSP")
    return
  end

  vim.lsp.buf.rename()
end

local function format_code()
  ensure_normal_mode()

  if not lsp_supports("textDocument/formatting") and not lsp_supports("textDocument/rangeFormatting") then
    notify("Format requires an attached LSP")
    return
  end

  vim.lsp.buf.format({ async = true })
end

local function goto_definition()
  ensure_normal_mode()

  if not lsp_supports("textDocument/definition") then
    notify("Go to definition requires an attached LSP")
    return
  end

  vim.lsp.buf.definition()
end

local function show_references()
  ensure_normal_mode()

  if not lsp_supports("textDocument/references") then
    notify("Find references requires an attached LSP")
    return
  end

  vim.lsp.buf.references()
end

local function code_action()
  ensure_normal_mode()

  if not lsp_supports("textDocument/codeAction") then
    notify("Code action requires an attached LSP")
    return
  end

  vim.lsp.buf.code_action()
end

local function with_comment_api(callback)
  local ok, api = pcall(require, "Comment.api")
  if not ok then
    notify("Comment.nvim is not loaded")
    return
  end

  callback(api)
end

local function toggle_line_comment()
  ensure_normal_mode()
  with_comment_api(function(api)
    api.toggle.linewise.current()
  end)
end

local function toggle_line_comment_visual()
  local mode = vim.fn.visualmode()
  local termcodes = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
  vim.api.nvim_feedkeys(termcodes, "nx", false)
  with_comment_api(function(api)
    api.toggle.linewise(mode)
  end)
end

local function toggle_block_comment()
  ensure_normal_mode()
  with_comment_api(function(api)
    api.toggle.blockwise.current()
  end)
end

local function toggle_block_comment_visual()
  local mode = vim.fn.visualmode()
  local termcodes = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
  vim.api.nvim_feedkeys(termcodes, "nx", false)
  with_comment_api(function(api)
    api.toggle.blockwise(mode)
  end)
end

function M.setup()
  -- vscode.vim provides the Vim-compatible baseline. Override the editor-aware
  -- actions here so Neovim uses native LSP and Comment.nvim where available.
  map({ "n", "i" }, "<A-f>", format_code, "Format document or selection")
  map("x", "<A-f>", format_code, "Format selection")
  map({ "n", "i" }, "<A-r>", rename_symbol, "Rename symbol")
  map({ "n", "i" }, "<F2>", rename_symbol, "Rename symbol")
  map("n", "<F12>", goto_definition, "Go to definition")
  map("n", "<S-F12>", show_references, "Find references")
  map({ "n", "x" }, "<C-.>", code_action, "Code action")
  map({ "n", "i" }, "<C-_>", toggle_line_comment, "Toggle line comment")
  map("x", "<C-_>", toggle_line_comment_visual, "Toggle line comment")
  map({ "n", "i" }, "<A-a>", toggle_block_comment, "Toggle block comment")
  map("x", "<A-a>", toggle_block_comment_visual, "Toggle block comment")

  if vim.fn.has("mac") == 1 or vim.fn.has("macunix") == 1 then
    map({ "n", "i" }, "<D-/>", toggle_line_comment, "Toggle line comment")
    map("x", "<D-/>", toggle_line_comment_visual, "Toggle line comment")
    map({ "n", "i" }, "<D-S-/>", toggle_block_comment, "Toggle block comment")
    map("x", "<D-S-/>", toggle_block_comment_visual, "Toggle block comment")
  end
end

return M
