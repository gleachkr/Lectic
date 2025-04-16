local M = {}

function M.explain_selection()
    local buf = vim.api.nvim_get_current_buf()
    local sel_start = vim.fn.min({ vim.fn.getpos("v")[2], vim.fn.getpos(".")[2]})
    local sel_end = vim.fn.max({ vim.fn.getpos("v")[2], vim.fn.getpos(".")[2]})
    local line_ptr = sel_start
    local sel_lines = vim.api.nvim_buf_get_lines(buf, sel_start - 1, sel_end, false)
    local buffer_content = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    vim.api.nvim_buf_set_lines(buf, sel_start - 1, sel_end, false, {""})
    vim.api.nvim_feedkeys("","n", false) --make sure to return to normal mode

    vim.api.nvim_set_option_value("modifiable", false, { buf = buf })

    local function on_exit(code, signal)
        vim.schedule(function()
            vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
        end)
    end

    local function on_stdout(err, data)
      assert(not err, err)
        if data then
          vim.schedule(function()
            vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
            vim.cmd.undojoin()
            local new_lines = vim.split(data, '\n')
            local cur_line = vim.api.nvim_buf_get_lines(buf, line_ptr - 1 , line_ptr, false)[1]
            new_lines[1] = cur_line .. new_lines[1]
            vim.api.nvim_buf_set_lines(buf, line_ptr - 1, line_ptr, false, new_lines)
            line_ptr = line_ptr + #new_lines - 1
            vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
          end)
        end
    end

    local process = vim.system({"lectic", "--Short"}, {
      stdin = true,
      stdout = on_stdout,
    }, on_exit)

    local query = table.concat(buffer_content, '\n')
        .. "\n\n"
        .. "Please rewrite this earlier selection from the discussion, adding more explanation and detail. "
        .. "Your output will be used to replace the text, so don't comment on what you're doing, just provide replacement text. \n\n"
        .. "<selection>" .. table.concat(sel_lines, '\n') .. "</selection>"

    process:write(query)
    process:write(nil)
end

return M
