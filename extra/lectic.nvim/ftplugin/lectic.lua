vim.api.nvim_buf_create_user_command(0, 'Lectic', function()
    require('lectic.submit').submit_lectic()
end, {})

vim.keymap.set('n', vim.g.lectic_key_submit or '<localleader>l', require('lectic.submit').submit_lectic, {
    buffer = true,
    desc = 'Generate next message with lectic'
})

vim.keymap.set('n', vim.g.lectic_key_cancel_submit or '<localleader>c', require('lectic.submit').cancel_submit, {
    buffer = true,
    desc = 'Cancel active message generation'
})

vim.opt_local.foldmethod = "expr"

vim.opt_local.foldexpr='v:lua.vim.lsp.foldexpr()'

vim.opt_local.foldtext='v:lua.vim.lsp.foldtext()'

require('lectic.highlight').highlight_blocks()

local highlight_timer = vim.uv.new_timer()

vim.api.nvim_create_autocmd("SafeState", {
    callback = function()
        highlight_timer:stop()
        highlight_timer:start(1000, 0, vim.schedule_wrap(function()
            require('lectic.highlight').highlight_blocks()
        end))
    end
})
