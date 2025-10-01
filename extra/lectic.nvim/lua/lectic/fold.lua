local M = {}

function M.fold_tool_calls()
  M.fold_tool_calls_range(1, 0) -- 0 for end of buffer, translates to -1
end

---@param start_line integer
---@param end_line integer
---@return integer
function M.fold_tool_calls_range(start_line, end_line)
  -- Stack for nested XML-like tags
  local stack = {}
  local buf = vim.api.nvim_get_current_buf()
  local last_fold = start_line
  local buffer_content = vim.api.nvim_buf_get_lines(
    buf, start_line - 1, end_line - 1, false
  )

  for i, line in ipairs(buffer_content) do
    -- Tokenize plausible tags only; avoids greedy matches
    for start_idx, raw in line:gmatch("()(<%s*/?%s*[%a_][%w._-]*[^>]*>)") do
      -- Skip declarations, comments, CDATA, processing instructions
      if not raw:match("^%s*<!") and not raw:match("^%s*<%?") then
        -- closing tag?
        local close_tag = raw:match("^%s*</%s*([%a_][%w._-]*)%s*>%s*$")
        if close_tag then
          if #stack > 0 and stack[#stack].tag == close_tag then
            local open_info = table.remove(stack)
            -- Only create folds for tool-call blocks whose opening tag
            -- started at column 1 (no indentation)
            if close_tag == "tool-call" and open_info.col1 then
              local start_fold = open_info.index
              local end_fold = i - 1
              -- Avoid 1-line folds
              if end_fold > start_fold then
                vim.api.nvim_buf_call(buf, function()
                  vim.cmd(
                    (start_fold + start_line)
                      .. ","
                      .. (end_fold + start_line)
                      .. "fold"
                  )
                end)
                last_fold = end_fold + start_line
              end
            end
          end
        else
          -- opening tag? (ignore self-closing)
          local open_tag = raw:match(
            "^%s*<%s*([%a_][%w._-]*)%s*[^>]*>%s*$"
          )
          local self_closing = raw:match("/>%s*$") ~= nil
          if open_tag and not self_closing then
            local col1 = (start_idx == 1)
            table.insert(stack, { tag = open_tag, index = i - 1, col1 = col1 })
          end
        end
      end
    end
  end

  return last_fold
end

function M.clear_folds(start_line, end_line)
  vim.cmd("silent! " .. start_line .. "," .. end_line .. "normal! zD")
end

---@param start_line integer
---@param end_line integer
---@return integer
function M.redo_folds(start_line, end_line)
  local view = vim.fn.winsaveview()
  local last_fold = M.fold_tool_calls_range(start_line, end_line)
  vim.fn.winrestview(view)
  return last_fold
end

return M
