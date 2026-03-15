local M = {}

vim.api.nvim_set_hl(0, 'LecticBlock', {
    link = vim.g.lectic_highlight_block or 'CursorLine',
    default = true
})

M.ns_id = vim.api.nvim_create_namespace('lectic_highlight')
local ns_id = M.ns_id

-- Per-buffer state:
--   ids   = extmark IDs we manage (block highlights only)
--   tick  = last changedtick we processed
--   dirty = true when on_lines detected a ::: in changed text
local buf_state = {}

-- ── Fence detection ─────────────────────────────────────────────────

local function is_fence_open(line)
    if #line < 4 or line:sub(1, 3) ~= ':::' then return false end
    local b = line:byte(4)
    return (b >= 48 and b <= 57)       -- 0-9
        or (b >= 65 and b <= 90)       -- A-Z
        or (b >= 97 and b <= 122)      -- a-z
        or b == 95                     -- _
end

local function is_fence_close(line)
    if #line < 3 or line:sub(1, 3) ~= ':::' then return false end
    for i = 4, #line do
        local b = line:byte(i)
        if b ~= 32 and b ~= 9 then return false end
    end
    return true
end

-- ── Buffer attachment ───────────────────────────────────────────────
-- Watch for edits that touch ::: lines so we know when a rescan is needed.

local function attach_buffer(bufnr)
    vim.api.nvim_buf_attach(bufnr, false, {
        on_lines = function(_, buf, _, first, _, last_new)
            local state = buf_state[buf]
            if not state or state.dirty then return end
            local lines = vim.api.nvim_buf_get_lines(buf, first, last_new, false)
            for _, line in ipairs(lines) do
                if #line >= 3 and line:sub(1, 3) == ':::' then
                    state.dirty = true
                    return
                end
            end
        end,
        on_detach = function(_, buf)
            buf_state[buf] = nil
        end,
    })
end

-- ── Extmark verification ────────────────────────────────────────────
-- Check that each managed extmark still sits on valid ::: fence lines.
-- Only fetches the specific start/end lines — no full-buffer scan.

local function verify_extmarks(bufnr, ids)
    local line_count = vim.api.nvim_buf_line_count(bufnr)
    for _, id in ipairs(ids) do
        local mark = vim.api.nvim_buf_get_extmark_by_id(bufnr, ns_id, id, { details = true })
        if not mark or #mark == 0 then return false end

        local start_row = mark[1]
        local details = mark[3]
        local end_row = details and details.end_row or start_row

        local start_line = vim.api.nvim_buf_get_lines(bufnr, start_row, start_row + 1, false)[1]
        if not start_line or not is_fence_open(start_line) then return false end

        if end_row < line_count - 1 then
            local end_line = vim.api.nvim_buf_get_lines(bufnr, end_row, end_row + 1, false)[1]
            if not end_line or not is_fence_close(end_line) then return false end
        end
    end
    return true
end

-- ── Full scan ───────────────────────────────────────────────────────

local function scan_blocks(bufnr)
    local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    local blocks = {}
    local in_block = false
    local start_line = nil

    for i, line in ipairs(lines) do
        if not in_block and is_fence_open(line) then
            in_block = true
            start_line = i - 1
        elseif in_block and is_fence_close(line) then
            blocks[#blocks + 1] = { start_line, i - 1 }
            in_block = false
        end
    end

    if in_block and start_line then
        blocks[#blocks + 1] = { start_line, #lines - 1 }
    end

    return blocks
end

-- ── Public API ──────────────────────────────────────────────────────

function M.highlight_blocks(bufnr)
    local tick = vim.api.nvim_buf_get_changedtick(bufnr)
    local state = buf_state[bufnr]

    -- First call for this buffer: attach on_lines watcher
    if not state then
        attach_buffer(bufnr)
        state = { tick = 0, ids = {}, dirty = true }
        buf_state[bufnr] = state
    end

    -- Skip entirely if buffer unchanged since last highlight
    if state.tick == tick then return end

    -- Fast path: if no ::: was touched, verify existing extmarks are
    -- still on valid fence lines. Fetches only 2 lines per block.
    if not state.dirty and #state.ids > 0 then
        if verify_extmarks(bufnr, state.ids) then
            state.tick = tick
            return
        end
    end

    -- Slow path: full rescan
    local blocks = scan_blocks(bufnr)

    -- Create new extmarks first (buffer is never without highlights)
    local new_ids = {}
    for _, block in ipairs(blocks) do
        local start_line, end_line = block[1], block[2]
        new_ids[#new_ids + 1] = vim.api.nvim_buf_set_extmark(bufnr, ns_id, start_line, 0, {
            end_row = end_line,
            end_col = 3,
            line_hl_group = 'LecticBlock',
            strict = false,
            spell = false,
        })
    end

    -- Then remove old managed extmarks (doesn't touch streaming/spinner)
    for _, id in ipairs(state.ids) do
        pcall(vim.api.nvim_buf_del_extmark, bufnr, ns_id, id)
    end

    buf_state[bufnr] = { tick = tick, ids = new_ids, dirty = false }
end

function M.remove_highlight_blocks(bufnr)
    local state = buf_state[bufnr]
    if state then
        for _, id in ipairs(state.ids) do
            pcall(vim.api.nvim_buf_del_extmark, bufnr, ns_id, id)
        end
    end
    buf_state[bufnr] = nil
end

-- Register an externally-created extmark (e.g. streaming) as managed.
-- It will be preserved during verification and replaced on rescan.
function M.track_extmark(bufnr, id)
    local state = buf_state[bufnr]
    if state then
        state.ids[#state.ids + 1] = id
        state.dirty = true
    end
end

-- Remove an extmark from the managed set without deleting it.
function M.untrack_extmark(bufnr, id)
    local state = buf_state[bufnr]
    if not state then return end
    for i, v in ipairs(state.ids) do
        if v == id then
            table.remove(state.ids, i)
            return
        end
    end
end

return M
