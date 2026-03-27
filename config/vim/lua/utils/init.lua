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

return M
