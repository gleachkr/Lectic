local M = {}

local spinner = require('lectic.spinner')

local ns_id = vim.api.nvim_create_namespace('lectic_highlight')

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
            local cur_total_lines = vim.api.nvim_buf_line_count(buf)
            new_lines[1] = cur_lines[1] .. new_lines[1]
            vim.api.nvim_buf_set_lines(buf, -2, -1, false, new_lines)

            -- Stack for nested XML blocks
            local stack = {}
            for i, line in ipairs(new_lines) do
              local open_tag = line:match('^<([%a_][%w._-]*)[^>]*>$')
              local close_tag = line:match('^</([%a_][%w._-]*)>$')
              if open_tag then
                table.insert(stack, {tag = open_tag, index = i - 1})
              elseif close_tag and #stack > 0 then
                local last_open = stack[#stack]
                if close_tag == last_open.tag then
                  local open_info = table.remove(stack)
                  local start_line = open_info.index + cur_total_lines - 1
                  local end_line = i + cur_total_lines - 2
                  -- Create a fold within buffer context
                  vim.api.nvim_buf_call(buf, function()
                    vim.cmd(start_line + 1 .. ',' .. end_line + 1 .. 'fold')
                  end)
                end
              end
            end

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

    local process = vim.system({"lectic", "-s"}, {
      stdin = true,
      stdout = on_stdout,
      env = env
    }, on_exit)

    the_spinner:start(vim.api.nvim_buf_line_count(buf) - 1)
    process:write(table.concat(buffer_content, '\n'))
    process:write(nil)

end

return M
