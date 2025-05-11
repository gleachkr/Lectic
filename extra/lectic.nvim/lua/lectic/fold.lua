local M = {}

function M.fold_tool_calls()
    M.fold_tool_calls_range(1,0) -- 0 for end of buffer, translates to -1
end

function M.fold_tool_calls_range(start_line, end_line)
    -- Stack for nested XML blocks
    local stack = {}
    local buf = vim.api.nvim_get_current_buf()
    local buffer_content = vim.api.nvim_buf_get_lines(buf, start_line - 1, end_line - 1, false)
    for i, line in ipairs(buffer_content) do
      local open_tag = line:match('^<([%a_][%w._-]*)[^>]*>$')
      local close_tag = line:match('^</([%a_][%w._-]*)>$')
      if open_tag then
        table.insert(stack, {tag = open_tag, index = i - 1})
      elseif close_tag and #stack > 0 then
        local last_open = stack[#stack]
        if close_tag == last_open.tag then
          local open_info = table.remove(stack)
          local start_fold = open_info.index
          local end_fold = i - 1
          -- Create a fold within buffer context
          vim.api.nvim_buf_call(buf, function()
            vim.cmd(start_fold + start_line .. ',' .. end_fold + start_line .. 'fold')
          end)
        end
      end
    end
end

function M.clear_folds(start_line, end_line)
   vim.cmd("silent! " .. start_line .. "," .. end_line .. "normal! zD")
end

function M.redo_folds(start_line, end_line)
   local view = vim.fn.winsaveview()
   M.clear_folds(start_line, end_line)
   M.fold_tool_calls_range(start_line, end_line)
   vim.fn.winrestview(view)
end

return M
