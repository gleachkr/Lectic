local M = {}

function M.consolidate()
    require('lectic.highlight').remove_highlight_blocks()
    if vim.fn.executable('lectic') == 1 then
        vim.cmd('%!lectic --consolidate')
        vim.cmd('normal! G')
    else
        vim.notify("Error: `lectic` binary is not found in the PATH.",
                  vim.log.levels.ERROR)
    end
end

return M
