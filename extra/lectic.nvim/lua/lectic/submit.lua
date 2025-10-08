local M = {}

local spinner = require('lectic.spinner')
local process

local ns_id = vim.api.nvim_create_namespace('lectic_highlight')

function M.cancel_submit()
    if process and not process:is_closing() then
        process:kill()
    end
end

function M.submit_lectic()
    if vim.fn.executable('lectic') ~= 1 then
        vim.notify("Error: `lectic` binary is not found in the PATH.", vim.log.levels.ERROR)
        return
    end

    local the_spinner = spinner.create_spinner(ns_id)

    local buf = vim.api.nvim_get_current_buf()
    if not vim.api.nvim_buf_get_lines(buf, -2,-1, false)[1]:match("^%s*$") then -- make sure we end in a blank line
        vim.api.nvim_buf_set_lines(buf, -1, -1, false, {""})
    end
    local total_lines = vim.api.nvim_buf_line_count(buf)
    local last_fold = total_lines
    local buffer_content = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local extmark_id = nil

    local function on_exit(code, signal)
        vim.schedule(function()
            vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
            the_spinner:done()
        end)
    end

    local function on_stdout(err, data)
      assert(not err, err)
        if data then
          vim.schedule(function()
            vim.cmd.undojoin()
            vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
            local cur_lines = vim.api.nvim_buf_get_lines(buf, -2, -1, true)
            local new_lines = vim.split(data, '\n')
            new_lines[1] = cur_lines[1] .. new_lines[1]
            vim.api.nvim_buf_set_lines(buf, -2, -1, false, new_lines)

            extmark_id = vim.api.nvim_buf_set_extmark(buf, ns_id, total_lines, 0, {
                end_row = vim.api.nvim_buf_line_count(buf) - 1,
                line_hl_group = 'LecticBlock',
                id = extmark_id,
                strict = false
            })

            the_spinner:goto(vim.api.nvim_buf_line_count(buf) - 1)
            vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
          end)
        end
    end

    local env = vim.fn.environ()
    env.NVIM = vim.v.servername

    vim.api.nvim_buf_set_lines(buf, -1, -1, false, {""}) -- start a new line to work on

    vim.api.nvim_set_option_value("modifiable", false, { buf = buf })

    process = vim.system({"lectic", "-s"}, {
      stdin = true,
      stdout = on_stdout,
      env = env,
      cwd = vim.fn.expand('%:h') == '' and nil or vim.fn.expand('%:h')
    }, on_exit)

    the_spinner:start(vim.api.nvim_buf_line_count(buf) - 1)
    process:write(table.concat(buffer_content, '\n'))
    process:write(nil)

end

return M
