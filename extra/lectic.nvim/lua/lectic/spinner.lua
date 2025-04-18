local M = {}

function M.create_spinner(ns_id)
    local buf = vim.api.nvim_get_current_buf()
    local steps = { " ▌"," ▀"," ▐"," ▄"}
    local cur_step = 1
    local timer = vim.uv.new_timer()
    local enclosed_line
    local id
    return {
        done = function(_)
            enclosed_line = 0
            vim.api.nvim_buf_del_extmark(buf, ns_id, id)
            timer:stop()
            timer:close()
        end,
        start = function(_, line)
            enclosed_line = line
            timer:start(250, 250, function()
                vim.schedule(function()
                    id = vim.api.nvim_buf_set_extmark(buf, ns_id, enclosed_line, 0, {
                        virt_text = {{ steps[cur_step] ,{"LecticBlock", "CursorLineSign"}}},
                        id = id
                    })
                end)
                cur_step = (cur_step % #steps) + 1
            end)
        end,
        goto = function(_, line)
            enclosed_line = line
            id = vim.api.nvim_buf_set_extmark(buf, ns_id, line, 0, {
                virt_text = {{ steps[cur_step] ,{"LecticBlock", "CursorLineSign"}}},
                id = id
            })
        end
    }
end

return M
