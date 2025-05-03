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
*   **Memory Consolidation:** Command and mapping to consolidate
    conversation history using `lectic --consolidate`.
*   **Selection Explanation:** Select text and ask `lectic` to explain it
    in more detail, replacing the selection with the elaborated response.
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
vim.g.lectic_key_consolidate = '<Leader>c'
-- Default: <localleader>e (Visual mode)
vim.g.lectic_key_explain = '<Leader>e'
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
    `zc`) to inspect them.
7.  To consolidate memories, use the consolidate mapping (default
    `<localleader>c`) or `:LecticConsolidate`. This replaces the buffer
    content with the consolidated version.
8.  To elaborate on a part of the conversation:
    *   Visually select the text you want explained.
    *   Use the explain mapping (default `<localleader>e` in visual mode).
    *   The selected text will be replaced by `lectic`'s explanation.

## Commands

*   `:Lectic`: Submit the current buffer to `lectic` for a response.
*   `:LecticConsolidate`: Replace buffer content with `lectic --consolidate`
    output.

## Default Keymaps

*   `<localleader>l` (Normal mode): Submit buffer (`:Lectic`).
*   `<localleader>c` (Normal mode): Consolidate memories (`:LecticConsolidate`).
*   `<localleader>e` (Visual mode): Explain selected text.
