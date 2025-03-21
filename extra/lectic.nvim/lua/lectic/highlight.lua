local M = {}

vim.api.nvim_set_hl(0, 'LecticBlock', {
    link = 'CursorLine',
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

function M.submit_lectic_async()
    if vim.fn.executable('lectic') ~= 1 then
        vim.notify("Error: `lectic` binary is not found in the PATH.", vim.log.levels.ERROR)
        return
    end

    local uv = vim.uv

    local buf = vim.api.nvim_get_current_buf()
    local total_lines = vim.api.nvim_buf_line_count(buf)
    local buffer_content = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local stdin = uv.new_pipe()
    local stdout = uv.new_pipe()
    local stderr = uv.new_pipe()

    local function on_exit(code, signal) end --unused exit handler

    local extmark_id = vim.api.nvim_buf_set_extmark(buf, ns_id, total_lines - 1, 0, {
      end_row = vim.api.nvim_buf_line_count(buf) - 1,
      line_hl_group = 'LecticBlock',
      strict = false
    })

    local function on_stdout(err, data)
      assert(not err, err)
        if data then
          vim.schedule(function()
            vim.api.nvim_buf_set_lines(buf, -1, -1, false, vim.split(data, '\n'))
            vim.api.nvim_buf_set_extmark(buf, ns_id, total_lines, 0, {
                end_row = vim.api.nvim_buf_line_count(buf) - 1,
                line_hl_group = 'LecticBlock',
                id = extmark_id,
                strict = false
            })
          end)
        end
    end

    local handle, pid = uv.spawn("lectic", {
      stdio = {stdin, stdout, stderr},
      args = {"-s"}
    }, on_exit)

    uv.read_start(stdout, on_stdout)

    stdin:write(table.concat(buffer_content, '\n'), function() stdin:close(); print("closed") end)

end

return M
