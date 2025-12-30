# lectic.nvim

Companion Neovim plugin for the [Lectic](https://github.com/gleachkr/lectic)
conversational LLM client.

## Features

*   **Filetype Detection:** Recognizes `.lec` and `.lectic` files.
*   **Asynchronous Interaction:** Send conversations to `lectic` and stream
    responses back into the buffer without blocking Neovim.
*   **Visual Feedback:** Displays a subtle spinner animation while `lectic`
    is processing.
*   **Response Highlighting:** Visually distinguishes LLM response blocks
    (`:::Name ... :::`).
*   **Tool Call Folding:** Automatically folds `<tool-call>...</tool-call>`
    blocks generated during interaction, showing the tool name in the fold.
*   **Configurable Mappings:** Set your own keybindings for common actions.
*   **Customizable Highlights:** Adjust the appearance of response blocks
    and the loading spinner.

## Requirements

*   Neovim (0.7+ recommended, uses `vim.system`, `vim.uv`).
*   The `lectic` executable installed and available in your `$PATH`.

## Installation

Use your preferred plugin manager:

**lazy.nvim:**

```lua
{
   'gleachkr/lectic',
    name = 'lectic.nvim',
    config = function(plugin)
        vim.opt.rtp:append(plugin.dir .. "/extra/lectic.nvim"
    end
}
```

**vim-plug:**

```vim
Plug 'gleachkr/lectic', { 'rtp': 'extra/lectic.nvim' }
```

## Configuration

The plugin provides sensible defaults, but you can customize keybindings
and appearance by setting some global variables.

**Keymaps:**

```lua
-- Default: <localleader>l
vim.g.lectic_key_submit = '<Leader>l'
-- Default: <localleader>c
vim.g.lectic_key_cancel_submit = '<Leader>c'
```

**Highlights:**

```lua
-- Highlight for LLM response blocks (links to CursorLine by default)
vim.api.nvim_set_hl(0, 'LecticBlock', { fg = '#add8e6', bg = '#2c2c2c', default = true })
-- Highlight for the loading spinner (links to CursorLineSign by default)
vim.api.nvim_set_hl(0, 'LecticSpinner', { fg = '#ffa500', default = true })

-- Or link them to existing groups
vim.api.nvim_set_hl(0, 'LecticBlock', { link = 'Visual', default = true })
vim.api.nvim_set_hl(0, 'LecticSpinner', { link = 'WarningMsg', default = true })

```

**Spinner:**

Customize the spinner characters:

```lua
vim.g.lectic_spinner_steps = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
```

## Usage

1.  Open a `.lec` file (or save a new buffer with `.lec`).
2.  Ensure the file has the required YAML frontmatter.
3.  Write your prompt or message at the end of the file.
4.  Use the submit mapping (default `<localleader>l`) or the `:Lectic`
    command to send the conversation to the LLM.
5.  The plugin will stream the response back into the buffer below your
    prompt. A spinner indicates activity. The new response block will be
    highlighted.
6.  Tool calls within the response will appear folded, showing the tool
    name (e.g., `[ python ]`). Use standard fold commands (`za`, `zo`,
    `zc`), or lsp hover (usually `K`) to inspect them.
8.  To interrupt an LLM that's generating text, use the cancel submit mapping 
    (default `<localleader>c`).

## Working Directory

When `lectic` is executed, the plugin ensures that the command runs in the same 
directory as the `.lec` file you are editing. This is important so that 
`lectic` can correctly resolve relative paths for any content references or 
tools you might be using in your conversation.

If you are working with an unsaved file, `lectic` will run in the directory of 
the current Neovim process.

## Default Keymaps

*   `<localleader>l` (Normal mode): Submit buffer (`:Lectic`).
*   `<localleader>c` (Normal mode): Interrupt text generation.

## Hook Integration with Neovim

When lectic runs from this plugin, the `NVIM` environment variable is set
to Neovim's RPC server address. This allows 
[hooks](https://gleachkr.github.io/Lectic/automation/02_hooks.html), [exec 
tools](https://gleachkr.github.io/Lectic/tools/02_exec.qmd) to communicate back 
to Neovim—for example, to send notifications when the assistant finishes a 
long-running task, or give a coding agent the ability to call some Neovim 
function.

Here's an example hook that sends a Neovim notification when tool use
completes:

```yaml
hooks:
  - on: assistant_message
    do: |
      #!/usr/bin/env bash
      if [[ "${TOOL_USE_DONE:-}" == "1" && -n "${NVIM:-}" ]]; then
        nvim --server "$NVIM" --remote-expr \
          "luaeval('vim.notify(\"Lectic: Assistant finished working\", vim.log.levels.INFO)')"
      fi
```

You can use any Neovim Lua API this way, for example to play a sound,
open a floating window, or trigger a custom autocmd. See the
[hooks documentation](https://gleachkr.github.io/Lectic/automation/02_hooks.html) for 
more details on available hook events and environment variables.
