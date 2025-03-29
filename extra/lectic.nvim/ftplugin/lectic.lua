vim.api.nvim_buf_create_user_command(0, 'Lectic', function()
    require('lectic.submit').submit_lectic()
end, {})

vim.api.nvim_buf_create_user_command(0, 'LecticConsolidate', function()
    require('lectic.consolidate').consolidate()
end, {})

vim.keymap.set('n', '<localleader>l', '<cmd>Lectic<CR>', {
    buffer = true,
    desc = 'Generate next message with lectic'
})

vim.keymap.set('n', '<localleader>c', '<cmd>LecticConsolidate<CR>', {
    buffer = true,
    desc = 'Consolidate LLM memories with lectic'
})

vim.opt_local.foldmethod = "manual"

vim.opt_local.foldtext='v:lua.require("lectic.fold").foldtext()'

require('lectic.highlight').highlight_blocks()
require('lectic.fold').fold_tool_calls()
