local M = {}

vim.api.nvim_set_hl(0, 'LecticSpinner', {
    link = vim.g.lectic_highlight_spinner or 'CursorLineSign',
    default = true
})

function M.create_spinner(ns_id)
    local buf = vim.api.nvim_get_current_buf()
    local steps = vim.g.lectic_spinner_steps or { "▌","▀","▐","▄"}
    local cur_step = 1
    local timer = vim.uv.new_timer()
    local enclosed_line
    local id
    return {
        done = function(_)
            timer:stop()
            timer:close()
            enclosed_line = 0
            vim.api.nvim_buf_del_extmark(buf, ns_id, id)
        end,
        start = function(_, line)
            enclosed_line = line
            timer:start(250, 250, function()
                vim.schedule(function()
                    id = vim.api.nvim_buf_set_extmark(buf, ns_id, enclosed_line, 0, {
                        virt_text = {{ steps[cur_step] ,{"LecticBlock", "LecticSpinner"}}},
                        id = id
                    })
                end)
                cur_step = (cur_step % #steps) + 1
            end)
        end,
        goto = function(_, line)
            enclosed_line = line
            id = vim.api.nvim_buf_set_extmark(buf, ns_id, line, 0, {
                virt_text = {{ steps[cur_step] ,{"LecticBlock", "LecticSpinner"}}},
                id = id
            })
        end
    }
end

return M
