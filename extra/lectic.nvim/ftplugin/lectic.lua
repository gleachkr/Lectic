vim.opt_local.number = false
vim.opt_local.relativenumber = false

vim.api.nvim_buf_create_user_command(0, 'Lectic', function()
    require('lectic.highlight').submit_lectic()
end, {})

vim.keymap.set('n', '<localleader>l', '<cmd>Lectic<CR>', {
    buffer = true,
    desc = 'Process file with lectic'
})

--require('lectic.highlight').override_conceal()
require('lectic.highlight').highlight_blocks()
