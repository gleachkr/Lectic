local M = {}

function M.setup(opts)
    opts = opts or {}
    require('lectic.filetype').setup()
end

return M
