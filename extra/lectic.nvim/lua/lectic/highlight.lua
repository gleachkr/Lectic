local M = {}

vim.api.nvim_set_hl(0, 'LecticBlock', {
    link = 'CursorLine',
    default = true
})

vim.fn.sign_define('lecticHighlightBlock', {
    text = "¦",
    texthl = 'LecticBlock',
    linehl = 'LecticBlock',
    numhl = 'LecticBlock'
})

-- XXX: Annoying limitation. There seems to be no way to get the background
-- color of the Conceal group to play nicely with the background color of the
-- LecticBlock highlight group
function M.highlight_blocks()
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    local in_block = false

    for i, line in ipairs(lines) do
        if line:match('^:::%s*%S+.*$') then
            in_block = true
        end

        if in_block then
            vim.fn.sign_place(i, 'lecticHighlightBlock', 'lecticHighlightBlock',
                vim.api.nvim_buf_get_name(0), { lnum = i })
            if line:match('^:::$') then
                in_block = false
            end
        end
    end
end

function M.remove_highlight_blocks()
    vim.fn.sign_unplace('lecticHighlightBlock')
end

function M.submit_lectic()
    M.remove_highlight_blocks()
    if vim.fn.executable('lectic') == 1 then
        vim.cmd('%!lectic')
        M.highlight_blocks()
        vim.cmd('normal! G')
    else
        vim.notify("Error: `lectic` binary is not found in the PATH.",
                  vim.log.levels.ERROR)
    end
end

return M
