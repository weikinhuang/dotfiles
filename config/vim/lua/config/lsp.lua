local M = {}

function M.setup()
  if type(vim.lsp.config) ~= "function" or type(vim.lsp.enable) ~= "function" then
    return
  end

  local capabilities = require("cmp_nvim_lsp").default_capabilities()
  local group = vim.api.nvim_create_augroup("dotfiles_lsp", { clear = true })
  local servers = {
    bashls = {},
    jsonls = {},
    lua_ls = {
      settings = {
        Lua = {
          completion = {
            callSnippet = "Replace",
          },
          diagnostics = {
            globals = { "vim" },
          },
          workspace = {
            checkThirdParty = false,
            library = vim.api.nvim_get_runtime_file("", true),
          },
        },
      },
    },
    taplo = {},
    vimls = {},
    yamlls = {},
  }

  vim.api.nvim_create_autocmd("LspAttach", {
    group = group,
    callback = function(args)
      local bufnr = args.buf
      local map = function(lhs, rhs, desc, mode)
        vim.keymap.set(mode or "n", lhs, rhs, {
          buffer = bufnr,
          desc = desc,
          silent = true,
        })
      end

      map("K", vim.lsp.buf.hover, "LSP hover")
      map("gD", vim.lsp.buf.declaration, "LSP declaration")
      map("gd", vim.lsp.buf.definition, "LSP definition")
      map("gi", vim.lsp.buf.implementation, "LSP implementation")
      map("gr", vim.lsp.buf.references, "LSP references")
      map("gy", vim.lsp.buf.type_definition, "LSP type definition")
      map("[g", function()
        vim.diagnostic.jump({ count = -1, float = true })
      end, "Previous diagnostic")
      map("]g", function()
        vim.diagnostic.jump({ count = 1, float = true })
      end, "Next diagnostic")
      map("<leader>a", vim.lsp.buf.code_action, "LSP code action", { "n", "v" })
      map("<leader>f", function()
        vim.lsp.buf.format({ async = true })
      end, "LSP format")
      map("<leader>rn", vim.lsp.buf.rename, "LSP rename")
    end,
  })

  for server, server_config in pairs(servers) do
    vim.lsp.config(server, vim.tbl_deep_extend("force", {
      capabilities = capabilities,
    }, server_config))
  end

  require("mason-lspconfig").setup({
    ensure_installed = vim.tbl_keys(servers),
    automatic_enable = vim.tbl_keys(servers),
  })
end

return M
