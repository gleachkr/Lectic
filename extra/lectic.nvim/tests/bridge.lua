-- Run from the repository root:
-- nvim --headless -u NONE -l extra/lectic.nvim/tests/bridge.lua
package.path = 'extra/lectic.nvim/lua/?.lua;' .. package.path
local bridge = require('lectic.bridge')
local clients = {}
local original_environ = vim.fn.environ
local original_get_clients = vim.lsp.get_clients
local requested
vim.fn.environ = function()
    return { LECTIC_EDITOR_SOCKET = 'inherited-wrong-editor', PATH = '/bin' }
end
vim.lsp.get_clients = function(filter)
    requested = filter
    return clients
end

local function client(socket)
    return {
        initialized = true,
        server_capabilities = {
            experimental = { lecticEditorBridgeSocket = socket },
        },
    }
end

local env = assert(bridge.environment(7))
assert(requested.bufnr == 7 and requested.name == 'lectic')
assert(env.LECTIC_EDITOR_SOCKET == nil)
assert(env.PATH == '/bin' and env.NVIM == vim.v.servername)
clients = { client('editor-a') }
env = assert(bridge.environment(7))
assert(env.LECTIC_EDITOR_SOCKET == 'editor-a')
clients = { client('editor-b') }
env = assert(bridge.environment(8))
assert(env.LECTIC_EDITOR_SOCKET == 'editor-b')
clients = { client(nil) } -- Compatibility with old LSPs.
assert(assert(bridge.environment(7)).LECTIC_EDITOR_SOCKET == nil)
clients = { client('a'), client('b') }
local missing, err = bridge.environment(7)
assert(missing == nil and err:match('Multiple'))
clients = { { initialized = false } }
missing, err = bridge.environment(7)
assert(missing == nil and err:match('initializing'))
vim.fn.environ = original_environ
vim.lsp.get_clients = original_get_clients
print('Neovim bridge environment tests passed')
