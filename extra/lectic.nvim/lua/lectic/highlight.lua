local M = {}

vim.api.nvim_set_hl(0, 'LecticBlock', {
    link = vim.g.lectic_highlight_block or 'CursorLine',
    default = true
})

-- Create a namespace for our extmarks
local ns_id = vim.api.nvim_create_namespace('lectic_highlight')

function M.highlight_blocks()
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    local in_block = false
    local start_line = nil
    local bufnr = vim.api.nvim_get_current_buf()

    -- Clear existing extmarks
    M.remove_highlight_blocks()

    -- Identify blocks and apply highlighting
    for i, line in ipairs(lines) do
        if line:match('^:::%s*%S+.*$') then
            in_block = true
            start_line = i - 1  -- 0-indexed for extmarks
        end

        if in_block and start_line and line:match('^:::$') then
            -- Add extmark for the entire block
            local end_line = i - 1  -- 0-indexed
            vim.api.nvim_buf_set_extmark(bufnr, ns_id, start_line, 0, {
                end_row = end_line,
                end_col = 3,
                line_hl_group = 'LecticBlock',
                strict = false
            })
            in_block = false
        end
    end

    -- If still in a block at EOF, close it
    if in_block and start_line then
        local end_line = #lines - 1  -- 0-indexed
        vim.api.nvim_buf_set_extmark(bufnr, ns_id, start_line, 0, {
            end_row = end_line,
            line_hl_group = 'LecticBlock',
            strict = false
        })
    end
end


function M.remove_highlight_blocks()
    local bufnr = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_clear_namespace(bufnr, ns_id, 0, -1)
end


return M

