local M = {}

-- Pin a run to its buffer's LSP, not another editor's workspace bridge.
function M.environment(buf)
    local env = vim.fn.environ()
    env.NVIM = vim.v.servername
    env.LECTIC_EDITOR_SOCKET = nil

    local clients = vim.lsp.get_clients({ bufnr = buf, name = 'lectic' })
    if #clients > 1 then
        return nil, 'Multiple Lectic LSP clients are attached to this buffer.'
    end
    local client = clients[1]
    if client then
        if not client.initialized then
            return nil, 'Lectic LSP is still initializing; try again shortly.'
        end
        local experimental = client.server_capabilities.experimental or {}
        local socket = experimental.lecticEditorBridgeSocket
        if type(socket) == 'string' and socket ~= '' then
            env.LECTIC_EDITOR_SOCKET = socket
        end
    end
    return env
end

return M
