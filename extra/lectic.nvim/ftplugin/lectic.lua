vim.api.nvim_buf_create_user_command(0, 'Lectic', function()
    require('lectic.submit').submit_lectic()
end, {})

vim.api.nvim_buf_create_user_command(0, 'LecticConsolidate', function()
    require('lectic.consolidate').consolidate()
end, {})

vim.keymap.set('n', vim.g.lectic_key_submit or '<localleader>l', require('lectic.submit').submit_lectic, {
    buffer = true,
    desc = 'Generate next message with lectic'
})

vim.keymap.set('n', vim.g.lectic_key_submit or '<localleader>c', require('lectic.submit').cancel_submit, {
    buffer = true,
    desc = 'Cancel active message generation'
})

vim.keymap.set('v', vim.g.lectic_key_explain or '<localleader>e', require('lectic.selection').explain_selection, {
    buffer = true,
    desc = 'Expand the selected text with more detail and explanation'
})

vim.opt_local.foldmethod = "manual"

function Lectic_foldtext()
  local start_line = vim.fn.getline(vim.v.foldstart)
  local tool_name = start_line:match('<tool%-call with="([^"]+)"')
  if tool_name then
    return ' [ ' .. tool_name .. ' ] '
  else
    return '...'
  end
end

vim.opt_local.foldtext='v:lua.Lectic_foldtext()'

require('lectic.highlight').highlight_blocks()
require('lectic.fold').fold_tool_calls()
