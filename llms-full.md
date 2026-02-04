

# Introduction to Lectic

Lectic is a unixy LLM toolbox. It treats conversations as plain text
files, which means you can version control them, grep them, pipe them,
email them, and edit them in whatever editor you like.

## What Problems Does Lectic Solve?

Most LLM tools ask you to work in *their* environment—a chat window, a
dedicated IDE, a web app. Lectic takes the opposite approach: it brings
LLMs into *your* environment. The conversation is a file. You edit it
with your editor. You run a command. The response appears.

This matters when you want to:

- **Keep your workflow.** You already have an editor you like, a
  terminal you’ve customized, scripts you’ve written. Lectic fits into
  that setup instead of replacing it.
- **Control your data.** Conversations are human-readable files on your
  disk. Back them up however you want. Delete them when you’re done.
  Email them if you want to. No cloud sync you didn’t ask for.
- **Automate LLM interactions.** Because Lectic is a command-line tool,
  you can script it, pipe to it, run it from cron jobs or git hooks.
- **Experiment freely.** Branch a conversation with git. Try different
  prompts. Diff the results.

The “conversation as file” approach is underexplored. Many “agentic”
coding tools are reinventing editor affordances in awkward ways—custom
UIs for editing, bespoke diff viewers, their own version of undo, or
evan a vim mode. Lectic sidesteps all of that. Your editor already does
those things.

## Core Principles

### Plain text all the way down

Every conversation is a markdown file (`.lec`). Because your
conversations are files, you can do anything with them that you can do
with files:

- **Version control**: Track changes with git, branch experiments, diff
  conversations.
- **Search**: `grep` across your conversation history.
- **Process**: Pipe conversations through other tools. Combine Lectic
  with `sed`, `pandoc`, or anything else.
- **Back up**: Copy files. Sync with rsync. Store wherever you want.

### Bring your own editor

Lectic includes an LSP server that provides completions, diagnostics,
hover information, go-to-definition, and folding for `.lec` files. You
can use Lectic with Neovim, VS Code, or any editor that speaks LSP.

For editors without LSP support, the basic workflow still works: edit a
file, run `lectic -i file.lec`, and the response is appended.

### Bring your own language

Tools, hooks, and macros are executables. Write them in whatever
language you prefer. If it can read environment variables and write to
stdout, it works with Lectic.

This means you’re not locked into a plugin ecosystem or a specific
scripting language. Your existing scripts and tools integrate directly.

### Composable primitives

Lectic provides a small set of building blocks:

- **`:cmd`**: Run a command and include its output.
- **`:fetch`**: Inline external content (file/URL) as text.
- **`:attach`**: Create an inline attachment from expanded content.
- **`:env`**: Read an environment variable.
- **`:verbatim`**: Include text without macro expansion.
- **`:once`**: Expand content only in the final message.
- **`:discard`**: Evaluate content for side effects, discard output.
- **`:ask` / `:aside`**: Switch between interlocutors.
- **`:reset`**: Clear conversation context.
- **Macros**: Reusable text expansions.
- **Hooks**: Run code on events (message sent, tool called, etc.).
- **Tools**: Give the LLM capabilities (shell, database, MCP servers).

> [!NOTE]
>
> ### What’s an “interlocutor”?
>
> Lectic calls LLM configurations “interlocutors” because they’re
> participants in a conversation. An interlocutor has a name, a prompt,
> and optionally tools and other settings. You can have multiple
> interlocutors in one conversation—each with different capabilities or
> personalities.

You combine these to build what you need: coding assistants, research
workflows, multi-agent systems, or simple one-shot text processing. See
the [Cookbook](./cookbook/index.qmd) for detailed recipes.

## Quick Example

A minimal conversation file:

``` markdown
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
---

What's 2 + 2?

:::Assistant

4

:::
```

The `---` block at the top is YAML configuration. Below it, you write
your message. The `:::Assistant` block is where the LLM’s response
appears—Lectic appends it when you run the command.

A more interesting setup with tools:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a code reviewer.
  tools:
    - exec: cat
      name: read_file
    - exec: rg --json
      name: search
---
```

``` markdown
Review the error handling in src/main.ts. Are there any uncaught
exceptions?

:::Assistant

<tool-call with="read_file">
<arguments><argv>["src/main.ts"]</argv></arguments>
<results>
<result type="text">
┆<stdout>// contents of main.ts...</stdout>
</result>
</results>
</tool-call>

Looking at the code, I can see several places where exceptions might not
be caught...

:::
```

The assistant reads files and searches the codebase to answer your
question. Tool calls appear inline in the response so you can see
exactly what happened.

## Next Steps

- [Getting Started](./02_getting_started.qmd): Install Lectic and run
  your first conversation.
- [Editor Integration](./03_editor_integration.qmd): Set up your editor
  for the best experience.
- [Configuration](./05_configuration.qmd): Learn about the configuration
  system.
- [Tools](./tools/01_overview.qmd): Give your LLM capabilities.
- [Cookbook](./cookbook/index.qmd): Ready-to-use recipes for common
  workflows.

All documentation concatenated into a single markdown file can be found
[here](./llms-full.md).



# Getting Started with Lectic

This short guide helps you install Lectic and run your first
conversation. Along the way, you will verify your install, set an API
key, and see a simple tool in action.

## Installation

Choose the method that fits your system.

#### Linux (AppImage)

Download the AppImage from the [GitHub Releases
page](https://github.com/gleachkr/Lectic/releases). Make it executable
and put it on your PATH.

``` bash
chmod +x lectic-*.AppImage
mv lectic-*.AppImage ~/.local/bin/lectic
```

#### macOS

Download the macOS binary from the [GitHub Releases
page](https://github.com/gleachkr/Lectic/releases) and put it on your
PATH.

#### Nix

If you use Nix, install directly from the repository:

``` bash
nix profile install github:gleachkr/lectic
```

## Verify the install

``` bash
lectic --version
```

If you see a version number, you are ready to go.

## Set up an API key

Lectic talks to LLM providers. Put at least one provider key in your
environment:

``` bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

Lectic chooses a default provider by checking for keys in this order:
Anthropic → Gemini → OpenAI → OpenRouter. You only need one.

> [!NOTE]
>
> You can also use your ChatGPT subscription with `provider: chatgpt`.
> This does not use an API key environment variable, so it is not
> auto-selected. On first use, Lectic opens a browser window for login
> and stores tokens at `$LECTIC_STATE/chatgpt_auth.json`.
>
> The login flow starts a local callback server on port 1455.

> [!WARNING]
>
> **Common issue:** If you see “No API key found,” make sure you
> exported the key in the same shell session where you’re running
> Lectic. If you set it in `.bashrc`, you may need to restart your
> terminal or run `source ~/.bashrc`.

## Your first conversation

### The conversation format

A Lectic conversation is a markdown file with a YAML header. The header
configures the LLM (which we call an “interlocutor”). Everything below
the header is the conversation: your messages as plain text, and the
LLM’s responses in special `:::Name` blocks.

Here’s a minimal example:

``` markdown
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
---

What is a fun fact about the Rust programming language?
```

The `name` identifies who’s speaking in the response blocks. The
`prompt` is the system prompt. Lectic picks a default provider and model
based on your API keys, so you don’t need to specify them.

### Create and run

Create a file called `hello.lec` with the content above, then run:

``` bash
lectic -i hello.lec
```

The `-i` flag updates the file in place. Lectic sends your message to
the LLM and appends the response:

``` markdown
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
---

What is a fun fact about the Rust programming language?

:::Assistant

Rust's mascot is a crab named Ferris! The name is a pun on "ferrous,"
relating to iron (Fe), which connects to "rust." You'll often see Ferris
in Rust documentation and community materials.

:::
```

To continue the conversation, add your next message below the `:::`
block and run `lectic -i hello.lec` again.

### Use a tool

Now let’s give the assistant a tool. Create a new file called
`tools.lec`:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  tools:
    - exec: date
      name: get_date
---

What is today's date?
```

Run Lectic again. The assistant block will now include an XML tool call
and the recorded results. You will see tags like `<tool-call>`,
`<arguments>`, and `<results>` in the block.

> [!TIP]
>
> You can load prompts from files or compute them with commands using
> `file:` and `exec:`. See [External
> Prompts](./context_management/03_external_prompts.qmd).

## Troubleshooting

Here are solutions to common issues when getting started.

### “No API key found” or similar error

Lectic needs at least one provider key in your environment. Make sure
you’ve exported it in the same shell session:

``` bash
lectic -i tools.lec
```

The response now includes an XML block showing the tool call and its
results:

``` markdown
:::Assistant

<tool-call with="get_date">
<arguments><argv>[]</argv></arguments>
<results>
<result type="text">
┆<stdout>Fri Jun 13 10:42:17 PDT 2025</stdout>
</result>
</results>
</tool-call>

Today is Friday, June 13th, 2025.

:::
```

The `<tool-call>` block is part of the conversation record. It shows
what the LLM requested, what arguments it passed, and what came back.
Editor plugins typically fold these blocks to reduce clutter.

> [!TIP]
>
> You can load prompts from files or compute them with commands using
> `file:` and `exec:`. See [External
> Prompts](./context_management/03_external_prompts.qmd).

## Tab completion (optional)

Lectic has an extensible tab completion system that supports standard
flags and [Custom Subcommands](./automation/03_custom_subcommands.qmd).

To enable it, source the completion script in your shell configuration
(e.g., `~/.bashrc`):

``` bash
# Adjust path to where you cloned/extracted Lectic
source /path/to/lectic/extra/tab_complete/lectic_completion.bash
```

Or place the script in `~/.local/share/bash-completion/completions/`.

## Troubleshooting

### Response is empty or tool calls aren’t working

Check that your YAML header is valid. Common mistakes:

- Indentation errors (YAML requires consistent spacing)
- Missing colons after keys
- Forgetting the closing `---` after the frontmatter

The LSP server catches many of these. See [Editor
Integration](./03_editor_integration.qmd) to set it up.

### “Model not found” errors

Model names vary by provider. Use `lectic models` to see what’s
available for your configured API keys.

### Tools aren’t being called

Make sure tools are defined under the `tools` key inside `interlocutor`,
not at the top level:

``` yaml
# Correct
interlocutor:
  name: Assistant
  prompt: You are helpful.
  tools:
    - exec: date
      name: get_date

# Wrong — tools at top level won't work
interlocutor:
  name: Assistant
  prompt: You are helpful.
tools:
  - exec: date
```

## Next steps

Now that you have Lectic working:

1.  **Set up your editor.** The intended workflow is to run Lectic with
    a single keypress. See [Editor
    Integration](./03_editor_integration.qmd) for Neovim, VS Code, and
    other editors.

2.  **Learn the configuration system.** You can set global defaults,
    project-specific settings, and per-conversation overrides. See
    [Configuration](./05_configuration.qmd).

3.  **Explore the cookbook.** The [Cookbook](./cookbook/index.qmd) has
    ready-to-use recipes for common workflows like coding assistants,
    commit message generation, and multi-perspective research.



# Editor Integration

Lectic is designed to work with your editor, not replace it. The core
workflow is: edit a file, press a key, watch the response stream in. No
mode switching, no separate chat window—you stay in your editor the
whole time.

This page covers setup for several editors. If you just want to get
started quickly:

- **Neovim**: Install the plugin from `extra/lectic.nvim`, add the LSP
  config below, and use `<localleader>l` to submit.
- **VS Code**: Install the extension from
  [releases](https://github.com/gleachkr/Lectic/releases) and use
  `Cmd+L` / `Alt+L`.
- **Other editors**: Run `lectic -i file.lec` from a keybinding.

## The LSP Server

Lectic includes a Language Server Protocol (LSP) server. You don’t
strictly need it—Lectic works fine as a command-line tool—but the LSP
makes editing `.lec` files much more pleasant:

- **Completions** for directives, macro names, YAML fields, model names,
  and tool types. Start typing and the LSP suggests what comes next.
- **Diagnostics** that catch YAML errors, missing configuration, and
  duplicate names before you run the file.
- **Folding** for tool-call blocks. Tool output can be verbose; folding
  keeps the conversation readable.
- **Hover information** showing what a directive does or what a macro
  expands to.
- **Go to definition** for macros, kits, and interlocutors defined in
  config files.

Start it with:

``` bash
lectic lsp
```

The server uses stdio transport and works with any LSP-capable editor.

## Neovim

The repository includes a full-featured plugin at `extra/lectic.nvim`.

### Installation

**lazy.nvim:**

``` lua
{
  'gleachkr/lectic',
  name = 'lectic.nvim',
  config = function(plugin)
    vim.opt.rtp:append(plugin.dir .. "/extra/lectic.nvim")
  end
}
```

**vim-plug:**

``` vim
Plug 'gleachkr/lectic', { 'rtp': 'extra/lectic.nvim' }
```

### Features

- **Filetype detection** for `.lec` and `.lectic` files
- **Async submission** — send conversations without blocking
- **Streaming responses** — watch the response appear in real-time
- **Visual feedback** — spinner while processing
- **Response highlighting** — distinguish LLM blocks from your text
- **Tool call folding** — collapsed by default, showing tool name
- **Selection explanation** — select text, ask for elaboration

### Default Keybindings

| Key              | Mode   | Action              |
|------------------|--------|---------------------|
| `<localleader>l` | Normal | Submit conversation |
| `<localleader>c` | Normal | Cancel generation   |
| `<localleader>e` | Visual | Explain selection   |

Customize with:

``` lua
vim.g.lectic_key_submit = '<Leader>l'
vim.g.lectic_key_cancel_submit = '<Leader>c'
vim.g.lectic_key_explain = '<Leader>e'
```

### LSP Setup

The plugin handles filetype detection. For LSP features, add:

``` lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "lectic", "markdown.lectic", "lectic.markdown" },
  callback = function(args)
    vim.lsp.start({
      name = "lectic",
      cmd = { "lectic", "lsp" },
      root_dir = vim.fs.root(args.buf, { ".git", "lectic.yaml" })
                 or vim.fn.getcwd(),
      single_file_support = true,
    })
  end,
})
```

For LSP-based folding:

``` lua
vim.opt.foldexpr = 'vim.lsp.foldexpr()'
```

## VS Code

An extension is available at `extra/lectic.vscode`. VSIX files are
distributed with
[releases](https://github.com/gleachkr/Lectic/releases/).

### Features

- **Generate Next Response** — stream LLM output into the editor
- **Explain Selection** — rewrite selected text with more detail
- **Block highlighting** — visual distinction for response blocks
- **Tool call folding** — collapse verbose tool output
- **LSP integration** — completions, diagnostics, and hovers

### Default Keybindings

| Key                        | Action                 |
|----------------------------|------------------------|
| `Alt+L` (`Cmd+L` on macOS) | Generate next response |
| `Alt+C` (`Cmd+C` on macOS) | Consolidate            |
| `Alt+E` (`Cmd+E` on macOS) | Explain selection      |

### Configuration

- `lectic.executablePath`: Path to `lectic` if not in PATH
- `lectic.blockBackgroundColor`: Background color for `:::` blocks

## Other Editors

Any editor that can run an external command on the current buffer works
with Lectic. The basic pattern:

``` bash
cat file.lec | lectic > file.lec
```

Or use `-i` for in-place updates:

``` bash
lectic -i file.lec
```

### Emacs

A minimal setup using `shell-command-on-region`:

``` elisp
(defun lectic-submit ()
  "Send the buffer to lectic and replace with output."
  (interactive)
  (shell-command-on-region
   (point-min) (point-max)
   "lectic"
   nil t))

(add-to-list 'auto-mode-alist '("\\.lec\\'" . markdown-mode))
(add-hook 'markdown-mode-hook
          (lambda ()
            (when (string-match-p "\\.lec\\'" (buffer-file-name))
              (local-set-key (kbd "C-c C-l") 'lectic-submit))))
```

For LSP support, use `eglot` or `lsp-mode`:

``` elisp
;; With eglot
(add-to-list 'eglot-server-programs
             '((markdown-mode :language-id "lectic")
               . ("lectic" "lsp")))
```

### Helix

Add to `languages.toml`:

``` toml
[[language]]
name = "lectic"
scope = "source.lectic"
file-types = ["lec", "lectic"]
language-servers = ["lectic-lsp"]
grammar = "markdown"

[language-server.lectic-lsp]
command = "lectic"
args = ["lsp"]
```

### Sublime Text

Install the LSP package, then add to LSP settings:

``` json
{
  "clients": {
    "lectic": {
      "command": ["lectic", "lsp"],
      "selector": "text.html.markdown",
      "file_patterns": ["*.lec"]
    }
  }
}
```

## Tips

- **Working directory matters.** When you run `lectic -i file.lec`,
  tools and file references resolve relative to the file’s directory.
  Most editor plugins handle this automatically.

- **Use the LSP for header editing.** Completions for model names, tool
  types, and interlocutor properties save time and catch typos.

- **Fold tool calls.** Long tool outputs can obscure the conversation.
  Both the Neovim and VS Code plugins fold these by default.

- **Stream for long responses.** The `-s` flag outputs just the new
  response, which editor plugins use to stream incrementally.



# The Lectic Conversation Format

Lectic conversations are stored in plain markdown files, typically with
a `.lec` extension. They use a superset of CommonMark, adding two
specific conventions: a YAML frontmatter block for configuration and
“container directives” for assistant responses.

## YAML Frontmatter

Every Lectic file begins with a YAML frontmatter block, enclosed by
three dashes (`---`). This is where you configure the conversation,
defining the interlocutor(s), their models, prompts, and any tools they
might use.

A minimal header looks like this:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
---
```

Lectic picks a default provider and model based on your environment
variables, so you often don’t need to specify them. If you want to be
explicit:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic
  model: claude-sonnet-4-20250514
---
```

The frontmatter can be closed with either three dashes (`---`) or three
periods (`...`). For a complete guide to all available options, see the
Configuration page.

## User Messages

Anything in the file that is not part of the YAML frontmatter or an
assistant response block is considered a user message. You write your
prompts, questions, and instructions here as plain text or standard
markdown.

``` markdown
This is a user message.

So is this. You can include any markdown you like, such as **bold text** or
`inline code`.
```

## Assistant Responses

Lectic uses “container directives” to represent messages from the LLM.
These are fenced blocks that start with a run of colons, followed
immediately by the name of the interlocutor.

The canonical form is exactly three colons on open and close, like this:

``` markdown
:::Name

Some content.

:::
```

Markdown code fences inside assistant blocks can also use three
backticks.

### Inline Attachments

Lectic records some generated content directly into the transcript as
**inline attachments**. These are created by:

- The `:attach[...]` directive (`kind="attach"`)
- Inline hooks (`kind="hook"`)

Inline attachments appear inside the assistant’s response block as XML.
They include a `<command>` field (the hook’s `do` value, or empty for
`:attach`) and a `<content>` field.

Example (`:attach[...]`):

``` xml
<inline-attachment kind="attach">
<command></command>
<content type="text/plain">
┆some content here
</content>
</inline-attachment>
```

Example (`:attach[:cmd[...]]`):

``` xml
<inline-attachment kind="attach">
<command></command>
<content type="text/plain">
┆<stdout from="git diff --staged">diff --git a/src/main.ts b/src/main.ts
┆...
┆</stdout>
</content>
</inline-attachment>
```

Example (inline hook output):

``` xml
<inline-attachment kind="hook" final="true">
<command>~/.config/lectic/my-hook.sh</command>
<content type="text/plain">
┆System check complete.
</content>
</inline-attachment>
```

Inline attachments serve two purposes:

1.  **Caching**: The results are stored in the file, so re-running
    Lectic doesn’t re-process old directives. Only `:attach` directives
    in the most recent user message are processed.

2.  **Context positioning**: When sending the conversation to the
    provider, attachments are treated as if they were a user message.
    This keeps provider caches stable and avoids token recomputation.

You’ll see inline attachments when using `:attach` (often with `:cmd`
inside) or inline hooks. They’re part of the conversation record and
should generally be left alone. Editor plugins typically fold them by
default to reduce visual clutter.

> [!TIP]
>
> Inline attachments are managed by Lectic. Don’t edit them by hand — if
> you need to re-run something, delete the attachment and add a new
> directive in your latest message.

### Example

Here is a complete, simple conversation file showing all the parts
together:

```` markdown
---
interlocutor:
  name: Oggle
  prompt: You are a skeptical assistant.
---

I'd like to know more about container directives.

:::Oggle

Are you sure? It seems like a rather niche topic. They are part of a
proposed extension to CommonMark that allows for custom block-level
elements.

Inside one of these blocks, standard markdown is still supported:

```python
# This is a regular code block
print("Hello from inside a directive!")
```

Is that all you wanted to know?

:::
````

When you run `lectic`, it reads the entire file, sends the content to
the LLM, and then appends the next assistant response in a new directive
block.



# Lectic Configuration

Lectic offers a flexible configuration system that lets you set global
defaults, create per-project settings, and make conversation-specific
overrides. This is managed through a hierarchy of YAML files.

## Configuration Hierarchy

Configuration settings are merged from multiple sources. Each source in
the list below overrides the one before it, with the `.lec` file’s own
header always having the final say.

1.  **System Config Directory**: Lectic first looks for a configuration
    file at `lectic/lectic.yaml` within your system’s standard config
    location (e.g., `~/.config/lectic/lectic.yaml` on Linux). This is
    the ideal place for your global, user-level defaults.

2.  **Working Directory**: Next, it looks for a `lectic.yaml` file in
    the current working directory. This is useful for project-level
    configuration that you might commit to a git repository.

3.  **Lectic File Header**: The YAML frontmatter within your `.lec` file
    is the final and highest-precedence source of configuration.

## Overriding Default Directories

You can change the default locations for Lectic’s data directories by
setting the following environment variables:

- `$LECTIC_CONFIG`: Overrides the base configuration directory path.
- `$LECTIC_DATA`: Overrides the data directory path.
- `$LECTIC_CACHE`: Overrides the cache directory path.
- `$LECTIC_STATE`: Overrides the state directory path.

These variables, along with `$LECTIC_TEMP` (a temporary directory) and
`$LECTIC_FILE` (the path to the active `.lec` file), are automatically
passed into the environment of any subprocesses Lectic spawns, such as
`exec` tools. This ensures your custom scripts have access to the same
context as the main process.

## Merging Logic

When combining settings from multiple configuration files, Lectic
follows specific rules:

- **Objects (Mappings)**: If the higher precedence source has a `name`
  attribute, and the name doesn’t match the `name` attribute of the
  lower precedence source, then the higher precedence source replaces
  the lower precedence source. Otherwise, the objects are combined and
  matching keys merged recursively.
- **Arrays (Lists)**: Merged based on the `name` attribute of their
  elements. If two objects in an array share the same `name`, they are
  merged. Otherwise, the elements are simply combined. This is
  especially useful for managing lists of tools and interlocutors. When
  duplicate named items appear within a single file, later entries
  override earlier ones. The LSP warns on duplicate names in the
  document header to help catch mistakes.
- **Other Values**: For simple values (strings, numbers) or if the types
  don’t match, the value from the highest-precedence source is used
  without any merging.

Additionally, the LSP validates header fields. It reports errors for
missing or mistyped interlocutor properties and warns when you add
unknown properties to an interlocutor mapping, which helps catch typos
in keys like `model` or `max_tokens`.

### Example

Imagine you have a global config in `~/.config/lectic/lectic.yaml`:

``` yaml
# ~/.config/lectic/lectic.yaml
interlocutors:
    - name: opus
      provider: anthropic
      model: claude-3-opus-20240229
```

And a project-specific file, `project.yaml`:

``` yaml
# ./project.yaml
interlocutor:
    name: haiku
    model: claude-3-haiku-20240307
    tools:
        - exec: bash
        - agent: opus
```

If you place this project config at `./lectic.yaml` in your working
directory, Lectic will merge it with your system defaults and the
document header using the precedence above. The `haiku` interlocutor
will be configured with the `claude-3-haiku` model, and it will have
access to a `bash` tool and an `agent` tool that can call `opus`. You
can switch to `opus` within the conversation if needed, using an
[`:ask[]` directive](./context_management/02_conversation_control.qmd).



# Providers and Models

Lectic speaks to several providers. You pick a provider and a model in
your YAML header, or let Lectic choose a default based on which
credentials are available in your environment.

## Picking a default provider

If you do not set `provider`, Lectic checks for keys in this order and
uses the first one it finds:

Anthropic → Gemini → OpenAI → OpenRouter.

Set one of these environment variables before you run Lectic:

- ANTHROPIC_API_KEY
- GEMINI_API_KEY
- OPENAI_API_KEY
- OPENROUTER_API_KEY

AWS credentials for Bedrock are not used for auto-selection. If you want
Anthropic via Bedrock, set `provider: anthropic/bedrock` explicitly and
make sure your AWS environment is configured.

## ChatGPT subscription (no API key)

Lectic also supports `provider: chatgpt`, which uses your ChatGPT
subscription via the official Codex / ChatGPT OAuth flow.

Notes:

- This provider is not auto-selected (there is no API key env var to
  check). If you want it by default, set `provider: chatgpt` in your
  `lectic.yaml` or in the `.lec` frontmatter.
- On first use, Lectic opens a browser window for login and stores
  tokens at `$LECTIC_STATE/chatgpt_auth.json` (for example,
  `~/.local/state/lectic/chatgpt_auth.json` on Linux).
- Login starts a local callback server on port 1455. If that port is in
  use, stop the other process and try again.
- If you want to “log out”, delete that file.

## Discover models

Not sure which models are available? Run:

``` bash
lectic models
```

This queries each provider you have credentials for and prints the
available models.

> [!TIP]
>
> The LSP can also autocomplete model names as you type in the YAML
> header. See [Editor Integration](./03_editor_integration.qmd).

> [!NOTE]
>
> `provider: chatgpt` models only show up in `lectic models` after you
> have logged in at least once (since the login is browser-based, not an
> API key). If you have not logged in yet, run a `.lec` file with
> `provider: chatgpt` first.

## OpenAI: two provider strings

OpenAI has two modes in Lectic today.

- `openai` selects the Responses API. Choose this when you want native
  tools like search and code.
- `openai/chat` selects the legacy Chat Completions API.

## Examples

These examples show the minimal configuration for each provider. You can
omit `provider` and `model` if you want Lectic to pick defaults based on
your environment.

**Anthropic** (direct API):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic
```

**Anthropic via Bedrock**:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic/bedrock
  model: anthropic.claude-3-haiku-20240307-v1:0
```

**OpenAI** (Responses API):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openai
```

**OpenAI Chat Completions** (legacy API):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openai/chat
```

**ChatGPT** (subscription via Codex backend):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: chatgpt
  model: gpt-5.1-codex
```

**Gemini**:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: gemini
```

**OpenRouter**:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openrouter
  model: meta-llama/llama-3.1-70b-instruct
```

**Ollama** (local inference):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: ollama
  model: llama3.1
```

## Capabilities and media

Providers differ in what they accept as input. Here’s a rough guide:

| Provider   | Text            | Images | PDFs | Audio    | Video |
|------------|-----------------|--------|------|----------|-------|
| Anthropic  | ✓               | ✓      | ✓    | ✗        | ✗     |
| Gemini     | ✓               | ✓      | ✓    | ✓        | ✓     |
| OpenAI     | ✓               | ✓      | ✓    | varies\* | ✗     |
| ChatGPT    | ✓               | ✓      | ✓    | varies\* | ✗     |
| OpenRouter | varies by model |        |      |          |       |
| Ollama     | ✓               | varies | ✗    | ✗        | ✗     |

\* Audio support depends on model. For OpenAI audio workflows you may
need `provider: openai/chat` with an audio-capable model.

Support changes quickly. Consult each provider’s documentation for
current limits on formats, sizes, and rate limits.

In Lectic, you attach external content by linking files in the user
message body. Lectic packages these and sends them to the provider in a
way that fits that provider’s API. See [External
Content](./context_management/01_external_content.qmd) for examples and
tips.



# Automation: Macros

Lectic supports a simple but powerful macro system that allows you to
define and reuse snippets of text. This is useful for saving frequently
used prompts, automating repetitive workflows, and composing complex,
multi-step commands.

Macros are defined in your YAML configuration (either in a `.lec` file’s
header or in an included configuration file).

## Defining Macros

Macros are defined under the `macros` key. Each macro must have a `name`
and an `expansion`. You can optionally provide an `env` map to set
default environment variables for the expansion. You can also provide an
optional `description`, which will be is shown in the LSP hover info for
the macro.

``` yaml
macros:
  - name: summarize
    expansion: >
      Please provide a concise, single-paragraph summary of our
      conversation so far, focusing on the key decisions made and
      conclusions reached.

  - name: build
    env:
      BUILD_DIR: ./dist
    expansion: exec:echo "Building in $BUILD_DIR"
```

### Expansion Sources

The `expansion` field can be a simple string, or it can load its content
from a file or from the output of a command, just like the `prompt`
field. For full semantics of `file:` and `exec:`, see [External
Prompts](../context_management/03_external_prompts.qmd).

- **File Source**: `expansion: file:./prompts/summarize.txt`
- **Command/Script Source**:
  - Single line: `expansion: exec:get-prompt-from-db --name summarize`
    (executed directly, not via a shell)

  - Multi‑line script: start with a shebang, e.g.

    ``` yaml
    expansion: |
      exec:#!/usr/bin/env bash
      echo "Hello, ${TARGET}!"
    ```

    Multi‑line scripts are written to a temp file and executed with the
    interpreter given by the shebang.

## Using Macros

To use a macro, you invoke it by writing the macro name as the directive
name:

- `:name[]` expands the macro.
- `:name[args]` expands the macro and also passes `args` to the
  expansion as the `ARG` environment variable.

When Lectic processes the file, it replaces the macro directive with the
full text from its `expansion` field.

> [!NOTE]
>
> ### Built-in Macros
>
> Lectic includes several built-in macros described in the next section.
> Because they are macros, they compose naturally with user-defined
> macros. For example, you can wrap `:cmd` in a caching macro:
> `:cache[:cmd[expensive-command]]`.

``` markdown
This was a long and productive discussion. Could you wrap it up?

:summarize[]
```

## Built-in Macros Reference

Lectic provides several built-in macros for common operations. These are
always available without any configuration.

### `:cmd` — Execute a Command

Runs a shell command and expands to the output wrapped in XML.

``` markdown
What's my current directory? :cmd[pwd]
```

Expands to:

``` xml
<stdout from="pwd">/home/user/project</stdout>
```

If the command fails, you get an error wrapper with both stdout and
stderr. See [External
Content](../context_management/01_external_content.qmd#command-output-via-cmd)
for full details on execution environment and error handling.

### `:env` — Read Environment Variables

Expands to the value of an environment variable. Useful for injecting
configuration or paths without running a command.

``` markdown
My home directory is :env[HOME]
```

If the variable is not set, `:env` expands to an empty string.

### `:fetch` — Inline External Content as Text

Fetch content from a local path or URI and inline it into your message
as a `<file ...>` block.

This is similar to using a Markdown link for attachments, but it
produces inline text (which composes naturally with other macros).

Examples:

``` markdown
:fetch[./README.md]
:fetch[<https://example.com>]
:fetch[[notes](./notes.md)]
```

For non-text content (images, PDFs, etc.), prefer Markdown links so
Lectic can attach the bytes to the provider request.

### `:verbatim` — Prevent Expansion

Returns the raw child text without expanding any macros inside it.

``` markdown
Here's an example of macro syntax: :verbatim[:cmd[echo hello]]
```

Expands to:

``` markdown
Here's an example of macro syntax: :cmd[echo hello]
```

The inner `:cmd` is not executed — it appears literally in the output.

### `:once` — Expand Only in Final Message

Only expands its children when processing the final (most recent) user
message. In earlier messages, it expands to nothing.

This is useful for commands that should only run once, not be
re-executed every time context is rebuilt:

``` markdown
:once[:cmd[expensive-analysis-script]]
```

When you add a new message and re-run Lectic, the `:once` directive in
older messages will produce no output, while the one in your latest
message will execute.

### `:discard` — Evaluate and Discard

Expands and evaluates its children (including any commands), but
discards the output entirely. Useful for side effects.

``` markdown
:discard[:cmd[echo "logged" >> activity.log]]
```

The command runs and writes to the log file, but nothing appears in the
conversation. You can combine `:once` and `:discard` for cases where you
only want the macro to run once, and you don’t want to pass the output
to the LLM.

### `:attach` — Create Inline Attachment

Captures its expanded children as an inline attachment stored in the
assistant’s response block. Only processed in the final message.

``` markdown
:attach[:cmd[git diff --staged]]
```

See [External
Content](../context_management/01_external_content.qmd#inline-attachments-with-attach)
for full details on how inline attachments work and when to use them.

## The Macro Expansion Environment

When a macro expands via `exec`, the script being executed can be pased
information via environment variables.

### Passing arguments to expansions via `ARG`

The text inside the directive brackets is passed to the macro expansion
as the `ARG` environment variable.

This works for both single-line `exec:` commands and multi-line `exec:`
scripts.

- `:name[hello]` sets `ARG=hello`.
- If you explicitly set an `ARG` attribute, it overrides the bracket
  content: `:name[hello]{ARG="override"}`.

### Passing other environment variables via attributes

You can pass environment variables to a macro’s expansion by adding
attributes to the macro directive. These attributes are injected into
the environment of `exec:` expansions when they run.

- `:name[]{FOO="bar"}` sets the variable `FOO` to `bar`.
- `:name[]{EMPTY}` sets the variable `EMPTY` to the empty string.
  `:name[]{EMPTY=""}` is equivalent.

Notes: - Single‑line `exec:` commands are not run through a shell. If
you need shell features, invoke a shell explicitly, e.g.,
`exec: bash -c 'echo "Hello, $TARGET"'`. - In single‑line commands,
variables in the command string are expanded before execution. For
multi‑line scripts, variables are available to the script via the
environment.

#### Example

**Configuration:**

``` yaml
macros:
  - name: greet
    expansion: exec: bash -c 'echo "Hello, $TARGET!"'
```

**Conversation:**

``` markdown
:greet[]{TARGET="World"}
```

When Lectic processes this, the directive will be replaced by the output
of the `exec` command, which is “Hello, World!”.

### Other Environment Variables

A few other environment variables are available by default.

| Name | Description |
|:---|:---|
| MESSAGE_INDEX | Index (starting from one) of the message containing the macro |
| MESSAGES_LENGTH | Total number of messages in the conversation |

These might be useful for conditionally running only if the macro is,
e.g. part of the most recent user message.

## Advanced Macros: Phases and Recursion

Macros can interact with each other recursively. To support complex
workflows, macros can define two separate expansion phases: `pre` and
`post`.

- **`pre`**: Expanded when the macro is first encountered (pre-order
  traversal). If `pre` returns content, the macro is replaced by that
  content, which is then recursively expanded. The original children are
  discarded.
- **`post`**: Expanded after the macro’s children have been processed
  (post-order traversal). The processed children are passed to `post` as
  the `ARG` variable.

If you define a macro with just `expansion`, it is treated as a `post`
phase macro.

Here’s how the phases work for a nested macro call like
`:outer[:inner[content]]`:

``` text
:outer[:inner[content]]
   │
   ▼
┌─────────────────────────────────────────────────────┐
│ 1. Run :outer's PRE                                 │
│    - If it returns content → replace :outer,        │
│      recursively expand the result, DONE            │
│    - If it returns nothing → continue to children   │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│ 2. Process children: :inner[content]                │
│    - Run :inner's PRE                               │
│    - Process :inner's children ("content")          │
│    - Run :inner's POST with children as ARG         │
│    - Replace :inner with result                     │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│ 3. Run :outer's POST                                │
│    - ARG = processed children (result of :inner)    │
│    - Replace :outer with result                     │
└─────────────────────────────────────────────────────┘
```

The key insight: `pre` lets you short-circuit (skip children entirely),
or change the children of a directive, while `post` lets you wrap or
transform the fully expanded results of the children.

### Handling “No Operation” in Pre

If the `pre` script runs but produces **no output** (an empty string),
Lectic treats this as a “pass-through”. The macro is NOT replaced;
instead, Lectic proceeds to process the macro’s children and then runs
the `post` phase.

This makes it easy to implement cache checks or conditional logic.

> [!TIP]
>
> If you explicitly want to **delete** a node during the `pre` phase
> (stopping recursion and producing no output), you cannot return an
> empty string. Instead, return an empty HTML comment: `<!-- -->`. This
> stops recursion and renders as nothing.

### Example: Caching

This design allows for powerful compositions, such as a caching macro
that wraps expensive operations.

``` yaml
macros:
  - name: cache
    # Check for cache hit. If found, cat the file.
    # If not found, the script produces no output (empty string),
    # so Lectic proceeds to expand the children.
    pre: |
      exec:#!/bin/bash
      HASH=$(echo "$ARG" | md5sum | cut -d' ' -f1)
      if [ -f "/tmp/cache/$HASH" ]; then
        cat "/tmp/cache/$HASH"
      fi
    # If we reached post, it means pre didn't return anything (cache miss).
    # We now have the result of the children in ARG. Save it and output it.
    post: |
      exec:#!/bin/bash
      HASH=$(echo "$ARG" | md5sum | cut -d' ' -f1)
      mkdir -p /tmp/cache
      echo "$ARG" > "/tmp/cache/$HASH"
      echo "$ARG"
```

Usage:

``` markdown
:cache[:summarize[:fetch[file.txt]]]
```

1.  `:cache`’s `pre` runs. If the cache exists for the raw text of the
    children, it returns the cached summary. Lectic replaces the
    `:cache` block with this text and is done.
2.  If `pre` returns nothing (cache miss), Lectic enters the children.
3.  `:fetch` expands to the file content.
4.  `:summarize` processes that content.
5.  Finally, `:cache`’s `post` runs. `ARG` contains the summary. It
    writes `ARG` to the cache and outputs it.



# Automation: Hooks

Hooks are a powerful automation feature that let you run custom commands
and scripts in response to events in Lectic’s lifecycle. Use them for
logging, notifications, post‑processing, or integrating with other tools
and workflows.

Hooks are defined in your YAML configuration under the `hooks` key,
per-tool in the `hooks` key of a tool specification, or per-interlocutor
in the `hooks` key of an interlocutor specification.

## Hook configuration

A hook has five possible fields:

- `on`: (Required) A single event name or a list of event names to
  listen for.
- `do`: (Required) The command or inline script to run when the event
  fires.
- `inline`: (Optional) A boolean. If `true`, the standard output of the
  command is captured and injected into the conversation. Defaults to
  `false`. Only applicable to `assistant_message` and `user_message`.
- `name`: (Optional) A string name for the hook. If multiple hooks have
  the same name (e.g., one in your global config and one in a project
  config), the one defined later (or with higher precedence) overrides
  the earlier one. This allows you to replace default hooks with custom
  behavior.
- `env`: (Optional) A map of environment variables to inject into the
  hook’s execution environment.

``` yaml
hooks:
  - name: logger
    on: [assistant_message, user_message]
    env:
      LOG_FILE: /tmp/lectic.log
    do: ./log-activity.sh
```

If `do` contains multiple lines, it is treated as a script and must
begin with a shebang (e.g., `#!/bin/bash`). If it is a single line, it
is treated as a command. Commands are executed directly (not through a
shell), so shell features like command substitution will not work.

Hook commands run synchronously. By default, their stdout, stderr, and
exit status are ignored by Lectic. However, if you set `inline: true`,
the standard output is captured and added to the conversation.

- For `user_message` events, the output is injected as context for the
  LLM before it generates a response. It also appears at the top of the
  assistant’s response block.
- For `assistant_message` events, the output is appended to the end of
  the assistant’s response block. This will trigger another reply from
  the assistant, so be careful to only fire an inline hook when you want
  the assistant to generate more content.

In the `.lec` file, inline hook output is stored as an XML
`<inline-attachment kind="hook">` block. The `<command>` element records
the hook’s `do` field so you can see what produced the output.

``` xml
<inline-attachment kind="hook">
<command>./my-hook.sh</command>
<content type="text/plain">
┆System check complete.
</content>
</inline-attachment>
```

## Available events and environment

Lectic emits three hook events. When an event fires, the hook process
receives its context as environment variables. No positional arguments
are passed. However, the hook may receive content via standard input.

- `user_message`
  - Environment:
    - `USER_MESSAGE`: The text of the most recent user message.
    - Standard Lectic variables like `LECTIC_FILE`, `LECTIC_CONFIG`,
      `LECTIC_DATA`, `LECTIC_CACHE`, `LECTIC_STATE`, and `LECTIC_TEMP`
      are also set when available.
    - `MESSAGES_LENGTH`: The length of the array of messages, including
      the current user message.
  - When: Just before the request is sent to the LLM provider.
- `assistant_message`
  - Standard Input: The raw markdown text of the conversation body up to
    this point.
  - Environment:
    - `ASSISTANT_MESSAGE`: The full text of the assistant’s response
      that was just produced.
    - `LECTIC_INTERLOCUTOR`: The name of the interlocutor who spoke.
    - `LECTIC_MODEL`: The model of the interlocutor who spoke.
    - `TOOL_USE_DONE`: Set to `1` when the assistant has finished using
      tools and is ready to conclude. Not set if there are pending tool
      calls. This lets inline hooks decide whether to inject follow-up
      content only when all work is complete.
    - `TOKEN_USAGE_INPUT`: Count of total input tokens used for this
      turn.
    - `TOKEN_USAGE_CACHED`: Count of cached input tokens used for this
      turn.
    - `TOKEN_USAGE_OUTPUT`: Count of output tokens used for this turn.
    - `TOKEN_USAGE_TOTAL`: Total tokens used for this turn.
    - `LOOP_COUNT`: How many times the tool calling loop has run
      (0-indexed).
    - `FINAL_PASS_COUNT`: How many times the assistant has finished work
      but was kept alive by an inline hook.
    - Standard Lectic variables as above.
  - When: Immediately after the assistant’s message is streamed.
- `tool_use_pre`
  - Environment:
    - `TOOL_NAME`: The name of the tool being called.
    - `TOOL_ARGS`: A JSON string containing the tool arguments.
    - Standard Lectic variables as above.
  - When: After tool parameters are collected but before execution.
  - Behavior: If the hook exits with a non-zero status code, the tool
    call is blocked, and the LLM receives a “permission denied” error.
- `error`
  - Environment:
    - `ERROR_MESSAGE`: A descriptive error message.
    - Standard Lectic variables as above.
  - When: Whenever an uncaught error is encountered.

## Hook headers and attributes

Hooks can pass metadata back to Lectic by including headers at the very
beginning of their output. Headers follow the format `LECTIC:KEY:VALUE`
or simply `LECTIC:KEY` (where the value defaults to “true”) and must
appear before any other content. The headers are stripped from the
visible output and stored as attributes on the inline attachment block.

``` bash
#!/usr/bin/env bash
echo "LECTIC:final"
echo ""
echo "System check complete. One issue found."
```

This would be recorded roughly like this:

``` xml
<inline-attachment kind="hook" final="true">
<command>./my-hook.sh</command>
<content type="text/plain">
┆System check complete. One issue found.
</content>
</inline-attachment>
```

Two headers affect control flow:

- `final`: When an inline hook generates output, Lectic normally
  continues the tool calling loop so that the assistant can see and
  respond to the new information. If the `final` header is present,
  Lectic prevents this extra pass, allowing the conversation turn to end
  immediately (unless the assistant explicitly called a tool).
- `reset`: When present, this header clears the conversation context up
  to the current message. The accumulated history sent to the provider
  is discarded, and the context effectively restarts from the message
  containing the hook output. This is useful for implementing custom
  context compaction or archival strategies when token limits are
  reached.

## Example: A simple logging hook

Let’s start with the simplest possible hook: logging every message to a
file. This helps you understand the basics before moving to more complex
examples.

``` yaml
hooks:
  - on: [user_message, assistant_message]
    do: |
      #!/usr/bin/env bash
      echo "$(date): Message received" >> /tmp/lectic.log
```

This hook fires on both user and assistant messages. It appends a
timestamp to a log file. That’s it—no return value, no interaction with
the conversation.

## Example: Human-in-the-loop tool confirmation

This example uses `tool_use_pre` to require confirmation before any tool
execution. It uses `zenity` to show a dialog box with the tool name and
arguments.

``` yaml
hooks:
  - on: tool_use_pre
    do: |
      #!/usr/bin/env bash
      # Display a confirmation dialog
      zenity --question \
             --title="Allow Tool Use?" \
             --text="Tool: $TOOL_NAME\nArgs: $TOOL_ARGS"
      # Zenity exits with 0 for Yes/OK and 1 for No/Cancel
      exit $?
```

## Example: Persisting messages to SQLite

This example persists every user and assistant message to an SQLite
database located in your Lectic data directory. You can later query this
for personal memory, project history, or analytics.

Configuration:

``` yaml
hooks:
  - on: [user_message, assistant_message]
    do: |
      #!/usr/bin/env bash
      set -euo pipefail
      DB_ROOT="${LECTIC_DATA:-$HOME/.local/share/lectic}"
      DB_PATH="${DB_ROOT}/memory.sqlite3"
      mkdir -p "${DB_ROOT}"

      # Determine role and text from available variables
      if [[ -n "${ASSISTANT_MESSAGE:-}" ]]; then
        ROLE="assistant"
        TEXT="$ASSISTANT_MESSAGE"
      else
        ROLE="user"
        TEXT="${USER_MESSAGE:-}"
      fi

      # Basic sanitizer for single quotes for SQL literal
      esc_sq() { printf %s "$1" | sed "s/'/''/g"; }

      TS=$(date -Is)
      FILE_PATH="${LECTIC_FILE:-}"
      NAME="${LECTIC_INTERLOCUTOR:-}"

      sqlite3 "$DB_PATH" <<SQL
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        role TEXT NOT NULL,
        interlocutor TEXT,
        file TEXT,
        text TEXT NOT NULL
      );
      INSERT INTO memory(ts, role, interlocutor, file, text)
      VALUES ('${TS}', '${ROLE}', '$(esc_sq "$NAME")',
              '$(esc_sq "$FILE_PATH")', '$(esc_sq "$TEXT")');
      SQL
```

Notes:

- Requires the `sqlite3` command-line tool to be installed and on your
  PATH.
- The hook inspects which variable is set to decide whether the event
  was a user or assistant message.
- `LECTIC_FILE` is populated when using `-f`/`-i` and may be empty when
  streaming from stdin.
- Adjust the table schema to suit your use case.

## Example: Automatically Injecting context

This example automatically runs `date` before every user message and
injects the output into the context. This allows the LLM to always know
the date and time without you needing to run :cmd\[date\]

``` yaml
hooks:
  - on: user_message
    inline: true
    do: 
      #!/usr/bin/env bash
      echo "<date-and-time>"
      date
      echo "</date-and-time>"
```

## Example: Notification when work completes

This example sends a desktop notification when the assistant finishes a
tool-use workflow. The hook checks `TOOL_USE_DONE` so you only get
notified once the work is actually done, not after each intermediate
step.

``` yaml
hooks:
  - on: assistant_message
    do: |
      #!/usr/bin/env bash
      if [[ "${TOOL_USE_DONE:-}" == "1" ]]; then
        notify-send "Lectic" "Assistant finished working"
      fi
```

This is especially useful for long-running agentic tasks where you want
to step away and be alerted when the assistant is done.

## Example: Neovim notification from hooks

When using the
[lectic.nvim](https://github.com/gleachkr/lectic/tree/main/extra/lectic.nvim)
plugin, the `NVIM` environment variable is set to Neovim’s RPC server
address. This allows hooks to communicate directly with your
editor—sending notifications, opening windows, or triggering any Neovim
Lua API.

This example sends a notification to Neovim when the assistant finishes
working:

``` yaml
hooks:
  - on: assistant_message
    do: |
      #!/usr/bin/env bash
      if [[ "${TOOL_USE_DONE:-}" == "1" && -n "${NVIM:-}" ]]; then
        nvim --server "$NVIM" --remote-expr \
          "luaeval('vim.notify(\"Lectic: Assistant finished working\", vim.log.levels.INFO)')"
      fi
```

The pattern `nvim --server "$NVIM" --remote-expr "luaeval('...')"` lets
you execute arbitrary Lua in the running Neovim instance. Some ideas:

- Play a sound: `vim.fn.system('paplay /usr/share/sounds/...')`
- Flash the screen: `vim.cmd('sleep 100m | redraw!')`
- Update a status line variable
- Trigger a custom autocommand:
  `vim.api.nvim_exec_autocmds('User', {pattern = 'LecticDone'})`

## Example: Reset context on token limit

This example checks the total token usage and, if it exceeds a limit,
resets the conversation context. It also uses the `final` header to stop
the assistant from responding to the reset message immediately.

``` yaml
hooks:
  - on: assistant_message
    inline: true
    do: |
      #!/usr/bin/env bash
      LIMIT=100000
      TOTAL="${TOKEN_USAGE_TOTAL:-0}"
      
      if [ "$TOTAL" -gt "$LIMIT" ]; then
        echo "LECTIC:reset"
        echo "LECTIC:final"
        echo ""
        echo "**Context cleared (usage: $TOTAL tokens).**"
      fi
```



# Automation: Custom Subcommands

Lectic’s CLI is extensible through “git-style” custom subcommands. If
you create an executable named `lectic-<command>`, or
`lectic-<command>.<file-extension>` and place it in your configuration
directory, data directory, or PATH, you can invoke it as
`lectic <command>`.

This allows you to wrap common workflows, build project-specific tools,
and create shortcuts for complex Lectic invocations.

## How It Works

When you run `lectic foo args...`, Lectic searches for an executable
named `lectic-foo` or `lectic-foo.*` in the following locations, in
order:

1.  **Configuration Directory**: `$LECTIC_CONFIG` (defaults to
    `~/.config/lectic` on Linux)
2.  **Data Directory**: `$LECTIC_DATA` (defaults to
    `~/.local/share/lectic` on Linux)
3.  **System PATH**: Any directory in your `$PATH`.

The first match found is executed. The subprocess receives the remaining
arguments, inherits the standard input, output, and error streams, and
has access to Lectic’s environment variables.

## Examples

### Bash Script

Create a file named `lectic-hello` in `~/.config/lectic/`:

``` bash
#!/bin/bash
echo "Hello from a custom subcommand!"
echo "My config dir is: $LECTIC_CONFIG"
```

Make it executable: `chmod +x ~/.config/lectic/lectic-hello`

Run it:

``` bash
lectic hello
```

### JavaScript/TypeScript via `lectic script`

Lectic bundles a Bun runtime, so you can write subcommands in
JavaScript, TypeScript, JSX, or TSX without installing anything extra.

`lectic script` works well as a shebang interpreter, and it bundles your
script before executing it. This lets you use explicit remote
`https://...` imports without a local `node_modules` (and `http://` is
allowed only for localhost).

For TSX/JSX scripts using React’s automatic runtime, include an explicit
`import React from "https://..."` so Lectic can resolve the implicit
`react/jsx-runtime` / `react/jsx-dev-runtime` imports.

Bundled output is cached on disk under `$LECTIC_CACHE/scripts/`. The
cache key includes the script contents, the Bun version, and an internal
plugin version. Delete that directory to force a re-bundle.

Note: remote imports are treated as pinned by URL. Changes on the remote
server will not invalidate the cache automatically.

Prefer versioned URLs so builds are reproducible. For example, when
using esm.sh, import `react@18.3.1` instead of `react`:

`import React from "https://esm.sh/react@18.3.1"`

Create `~/.config/lectic/lectic-calc`:

``` javascript
#!/usr/bin/env -S lectic script

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: lectic calc <expression>");
  process.exit(1);
}

// Access standard Lectic environment variables
const configDir = process.env.LECTIC_CONFIG;

try {
  console.log(eval(args.join(" ")));
} catch (e) {
  console.error("Error:", e.message);
}
```

Make it executable and run:

``` bash
lectic calc 1 + 2
```

> [!TIP]
>
> ### Why `lectic script`?
>
> You get Bun’s full capabilities without installing Bun separately.
> This includes built-in YAML parsing, HTTP servers, SQLite, `fetch`,
> and much more. See [Bun’s documentation](https://bun.sh/docs) for
> what’s available.
>
> Because Lectic bundles your script first, you can also write
> self-contained TSX/JSX scripts that pull dependencies from explicit
> `https://...` imports.
>
> This is especially useful for writing more complex subcommands that
> would be awkward in Bash.

## Environment Variables

Subcommands receive the standard set of Lectic environment variables:

- `LECTIC_CONFIG`: Path to the configuration directory.
- `LECTIC_DATA`: Path to the data directory.
- `LECTIC_CACHE`: Path to the cache directory.
- `LECTIC_STATE`: Path to the state directory.
- `LECTIC_TEMP`: Path to the temporary directory.

These ensure your subcommands respect the user’s directory
configuration.

## Tab Completion

You can add tab completion for your custom subcommands. The completion
system supports plugging in custom completion functions.

### Installation

First, ensure you have enabled tab completion by sourcing the completion
script in your shell configuration (e.g., `~/.bashrc`):

``` bash
source /path/to/lectic/extra/tab_complete/lectic_completion.bash
```

(The path depends on how you installed Lectic. If you installed via Nix
or an AppImage, you may need to locate this file in the repository or
extract it.)

### Adding Completions

To provide completions for a subcommand `lectic-foo`, create a bash
script that defines a completion function and registers it.

The script can be placed in: 1. `~/.config/lectic/completions/` 2.
`~/.local/share/lectic/completions/` 3. Or alongside the executable
itself, named `lectic-foo.completion.bash`.

**Example:**

Create `~/.config/lectic/completions/foo.bash`:

``` bash
_lectic_complete_foo() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  # Suggest 'bar' and 'baz'
  COMPREPLY=( $(compgen -W "bar baz" -- "${cur}") )
}

# Register the function for the 'foo' subcommand
lectic_register_completion foo _lectic_complete_foo
```

Now, typing `lectic foo <TAB>` will suggest `bar` and `baz`.

> [!TIP]
>
> For performance, define completions in a separate `.completion.bash`
> file rather than inside the subcommand script itself. This allows the
> shell to load completions without executing the subcommand.



# Managing Context: External Content

Lectic aims to make it easy to pull external information into the
conversation, providing the LLM with the context it needs to answer
questions, analyze data, or perform tasks.

This is done in two primary ways: by referencing files and URIs using
standard Markdown links, and by executing shell commands with the `:cmd`
directive.

## Content References via Markdown Links

You can include local or remote content using the standard Markdown link
syntax, `[Title](URI)`. Lectic will fetch the content from the URI and
include it in the context for the LLM.

``` markdown
Please summarize this local document: [Notes](./notes.md)

Analyze the data in this S3 bucket: [Dataset](s3://my_bucket/dataset.csv)

What does this README say?
[Repo](github+repo://gleachkr/Lectic/contents/README.md)
```

### Supported Content Types

- **Text**: Plain text files are included directly.
- **Images**: PNG, JPEG, GIF, and WebP images are supported.
- **PDFs**: Content from PDF files can be extracted (requires a provider
  that supports PDF ingestion, such as Anthropic, Gemini, or OpenAI).
- **Audio**: Gemini and OpenAI support audio inputs. For OpenAI, use
  `provider: openai/chat` with an audio‑capable model; supported formats
  include MP3, MPEG, and WAV. Gemini supports a broader set of audio
  types.
- **Video**: Gemini supports video understanding. See supported formats
  in Google’s docs:
  https://ai.google.dev/gemini-api/docs/video-understanding#supported-formats

### URI Schemes

Lectic supports several URI schemes for referencing content:

- **Local Files**: Simple relative paths like `./src/main.rs` or
  absolute `file:///path/to/file.txt` URIs.
- **Remote Content**: `http://` and `https://` for web pages and other
  online resources.
- **Amazon S3**: `s3://` for referencing objects in S3 buckets. This
  requires AWS credentials to be configured in your environment.
- **MCP Resources**: You can reference resources provided by an MCP
  server using a custom scheme, like `github+repo://...`, where `github`
  is the name of the MCP server (provided in the tool specification),
  and the rest is the resource URL.

A few convenience rules apply:

- For local file references using `file://`, use absolute paths. A
  portable way to build these is with `$PWD` (e.g.,
  `file://$PWD/papers/some.pdf`).
- Environment variables in URIs use the `$VAR` form; `${VAR}` is not
  supported. Expansion happens before any globbing.
- Environment variable expansion also applies to bare local paths
  (non‑URL links), such as `./$DATA_ROOT/file.txt`. Expansion happens
  before any globbing.

You can use glob patterns to include multiple files at once. This is
useful for providing the entire source code of a project as context.

``` markdown
[All source code](./src/**/*.ts)
[All images in this directory](./images/*.jpg)
```

Lectic uses Bun’s [Glob API](https://bun.sh/docs/api/glob) for matching.

### Advanced URI Features

Using full `file://` URIs for local content enables additional
capabilities.

#### Environment Variable Expansion

Lectic supports environment variable expansion in URIs. This helps in
creating portable `.lec` files that don’t rely on hardcoded absolute
paths.

``` markdown
[My dataset](file://$DATA_ROOT/my_project/data.csv)
[Log file](file://$PWD/logs/latest.log)
```

#### PDF Page Selection

When referencing a PDF, you can point to a specific page or a range of
pages by adding a fragment to the URI. Page numbering starts at 1.

- **Single Page**: `[See page 5](file.pdf#page=5)`
- **Page Range**: `[See Chapter 2](book.pdf#pages=20-35)`

If both `page` and `pages` are supplied, `pages` takes precedence. If a
page or range is malformed or out of bounds, Lectic will surface an
error that is visible to the LLM.

## Command Output via `:cmd`

Use `:cmd[...]` to execute a shell command and insert its output
directly into your message. Think of it as a built-in
[macro](../automation/01_macros.qmd) that runs a command and pastes in
the result.

``` markdown
What can you tell me about my system? :cmd[uname -a]
```

When Lectic processes this, it runs `uname -a` and replaces the
`:cmd[...]` directive with the command’s output wrapped in XML:

``` xml
<stdout from="uname -a">Linux myhost 6.1.0 ...</stdout>
```

If the command fails (non-zero exit code), you get an error wrapper
instead:

``` xml
<error>Something went wrong when executing a command:<stdout from="bad-cmd">
</stdout><stderr from="bad-cmd">bad-cmd: command not found</stderr></error>
```

### When `:cmd` runs

`:cmd` directives are expanded at the beginning of each user turn. You
can also expand them with an [LSP](../reference/03_lsp.qmd) code action.
If you want a `:cmd` directive to expand only once, you can wrap it in
`:attach[..]` (see below) which will store the results in the lectic
document as an attachment, or you can implement some other caching
mechanism using the macro system.

### Execution environment

- `:cmd` runs with Bun’s `$` shell in the current working directory.
- Standard Lectic environment variables like `LECTIC_FILE` are
  available.
- Line breaks inside `:cmd[...]` are ignored, so wrapped commands work:

``` markdown
:cmd[find . -name "*.ts" 
     | head -20]
```

### Use cases

- **System information**:
  `What can you tell me about my system? :cmd[uname -a]`
- **Project state**: `Write a commit message: :cmd[git diff --staged]`
- **Data snippets**: `Analyze this: :cmd[head -50 data.csv]`

## Inline Attachments with `:attach`

While `:cmd` inserts command output directly into your message text,
sometimes you want to provide context that appears as a separate
attachment — for example, to keep the conversation transcript cleaner or
to control caching behavior.

The `:attach[...]` directive creates an **inline attachment**. The
content inside the brackets is stored in the assistant’s response block
(after macro expansion) and sent to the LLM as additional user context.

``` markdown
Here's the current state of the config:

:attach[:config_status_macro[]]

What do you think of this configuration?
```

When Lectic processes this, it creates an inline attachment that appears
at the top of the assistant’s response:

``` xml
<inline-attachment kind="attach">
<command></command>
<content type="text/plain">
┆server:
┆  port: 8080
┆  host: localhost
</content>
</inline-attachment>
```

### Combining `:attach` with `:cmd`

You can compose `:attach` and `:cmd` to get the best of both worlds —
run a command and store its output as an attachment:

``` markdown
Review this diff: :attach[:cmd[git diff --staged]]
```

This executes `git diff --staged`, then wraps the result as an inline
attachment. The attachment is cached in the transcript, so re-running
Lectic won’t re-execute the command.

> [!TIP]
>
> ### When to use `:cmd` vs `:attach[:cmd[...]]`
>
> Use **`:cmd[...]`** when you want command output inlined directly in
> your message. The output becomes part of the message text.
>
> Use **`:attach[:cmd[...]]`** when you want the output stored as a
> cached attachment. This is useful for large outputs or when you want
> to preserve provider cache efficiency (for example, if the output of
> `:cmd` might change in between user turns).

### How inline attachments work

Inline attachments serve two purposes:

1.  **Caching**: Results are stored in the file, so re-running Lectic
    doesn’t re-execute commands or re-process content. Only `:attach`
    directives in the most recent user message are processed.

2.  **Context positioning**: When sending the conversation to the
    provider, attachments are treated as if they were a user message
    immediately preceding the assistant’s response. This keeps provider
    caches stable.

Inline attachments appear in the `.lec` file as XML blocks inside the
assistant response. Editor plugins typically fold them by default to
reduce visual clutter.

> [!TIP]
>
> Inline attachments are managed by Lectic. Don’t edit them by hand — if
> you need to re-run a command, delete the attachment and add a new
> `:attach` directive in your latest message.



# Managing Context: Conversation Control

Beyond simply adding external data, Lectic provides directives that
allow you to actively manage the flow of a conversation. You can switch
between different LLM interlocutors and control the context window that
is sent to the model.

## Multiparty Conversations with `:ask` and `:aside`

Lectic allows you to define multiple interlocutors in the YAML
frontmatter. This enables you to bring different “personalities” or
models with different capabilities into a single conversation.

To do this, use the `interlocutors` key (instead of `interlocutor`) and
provide a list of configurations.

``` yaml
---
interlocutors:
  - name: Boggle
    provider: anthropic
    model: claude-3-sonnet-20240229
    prompt: You are an expert on personal finance.
  - name: Oggle
    provider: gemini
    prompt: You are very skeptical of conventional financial advice.
---
```

Once multiple interlocutors are defined, Lectic will continue with
whichever one was last active. To direct your message to a specific
interlocutor, you use the `:ask` and `:aside` directives.

### `:ask[Name]` - Permanently Switch Interlocutor

The `:ask[InterlocutorName]` directive changes the active speaker. All
subsequent conversation turns will be handled by this new interlocutor
until another `:ask` directive is used.

``` markdown
:ask[Boggle] What is the best way to save for retirement?

:::Boggle
The most common advice is to invest in a diversified portfolio of low-cost
index funds.
:::

:ask[Oggle] What's your take on that?

:::Oggle
"Common advice" is often just dogma. That strategy leaves you completely
exposed to market downturns.
:::
```

### `:aside[Name]` - Switch for a Single Turn

The `:aside[InterlocutorName]` directive is for a one-off question or
comment. It directs the current message to the specified interlocutor,
but the conversation then reverts back to the previously active speaker
for the *next* user message.

This is useful for quick interjections or for getting a second opinion
without derailing the main flow of the conversation.

## Context Management with `:reset`

As a conversation grows longer, the context sent to the LLM on each turn
also grows. This can increase costs and, in some cases, lead to the
model getting “stuck” on earlier parts of the dialogue.

The `:reset[]` directive gives you manual control over the context
window. When Lectic processes a message containing `:reset[]`, it
instructs the LLM to **ignore all preceding conversation history**. The
context for that turn effectively begins with the message containing the
directive.

``` markdown
...a very long conversation happens here...

Okay, let's start fresh. I'm going to :reset[] your context now. Please
summarize our previous discussion and then we can move on to the next topic.

:::Assistant
Understood. I have cleared my context.

Previously, we discussed the history of the Roman Empire, focusing on the
reign of Augustus and the establishment of the Pax Romana. We concluded that
economic stability was a key factor in the era's success.

I am ready for the next topic.
:::

Excellent. Now, how did this conversation begin?

:::Assistant
This conversation began with you instructing me to reset my context and provide
a summary of our previous discussion about the Roman Empire.
:::
```

This is a powerful tool for managing long-running conversations,
allowing you to “compact” the context manually or with the help of the
LLM.

## Dynamic Configuration with `:merge_yaml` and `:temp_merge_yaml`

Sometimes you need to change the configuration of the conversation on
the fly. Lectic provides two directives for this purpose, allowing you
to merge new YAML configuration into the header.

### `:merge_yaml[YAML]` - Permanently Update Configuration

The `:merge_yaml` directive allows you to permanently update the
conversation’s configuration. The provided YAML is merged with the
existing header, overriding any existing keys.

``` markdown
:merge_yaml[{ interlocutor: { model: "claude-3-opus-20240229" } }]
```

This change persists for all subsequent turns in the conversation.

### `:temp_merge_yaml[YAML]` - Temporarily Update Configuration

The `:temp_merge_yaml` directive updates the configuration for the
*current turn only*. This is useful for one-off changes, such as
temporarily increasing the `max_tokens` limit or enabling a specific
tool.

``` markdown
:temp_merge_yaml[{ interlocutor: { max_tokens: 4000 } }]
```

Once the turn is complete, the configuration reverts to its previous
state for subsequent messages.



# External Prompts and Instructions

Many Lectic fields can load their text from outside the document. You
can point a field at a file on disk, or run a command (or script) and
use its output. This lets you keep prompts, usage text, and notes in one
place, or compute them on demand.

What supports external sources:

- interlocutor.prompt
- macros\[\].expansion
- tools\[\].usage (for tools that accept a usage string)
- tools\[\].details (for tools that provide extra details)

Each of these accepts either a plain string, or a string beginning with
one of the prefixes below.

## `file:PATH`

Loads the contents of PATH and uses that as the field value. Environment
variables in the path are expanded before reading.

Examples

``` yaml
interlocutor:
  name: Assistant
  prompt: file:./prompts/assistant.md
```

``` yaml
macros:
  - name: summarize
    expansion: file:$HOME/.config/lectic/prompts/summarize.txt
```

## `exec:COMMAND` or `exec:SCRIPT`

Runs the command and uses its stdout as the field value. There are two
forms:

- Single line: executed directly, not through a shell. Shell features
  like globbing and command substitution do not work. If you need them,
  invoke a shell explicitly (for example, `bash -lc '...'`).
- Multi‑line: treated as a script. The first line must be a shebang (for
  example, `#!/usr/bin/env bash`). The script is written to a temporary
  file and executed with the interpreter from the shebang.

Environment variables in a single‑line command are expanded before
running. For multi‑line scripts, variables are available via the process
environment at runtime.

## Examples

Single line

``` yaml
interlocutor:
  name: Assistant
  prompt: exec:echo "You are a helpful assistant."
```

Multi‑line script

``` yaml
interlocutor:
  name: Assistant
  prompt: |
    exec:#!/usr/bin/env bash
    cat <<'PREFACE'
    You are a helpful assistant.
    You will incorporate recent memory below.
    PREFACE
    echo
    echo "Recent memory:"
    sqlite3 "$LECTIC_DATA/memory.sqlite3" \
      "SELECT printf('- %s (%s)', text, ts) FROM memory \
       ORDER BY ts DESC LIMIT 5;"
```

## Working directory and environment

- `file:` and `exec:` resolve relative paths and run commands in the
  current working directory of the lectic process (the directory from
  which you invoked the command). If you used -f or -i, note that the
  working directory does not automatically switch to the .lec file’s
  directory for these expansions. Use absolute paths or cd if you need a
  different base.
- Standard Lectic environment variables are provided, including
  `LECTIC_CONFIG`, `LECTIC_DATA`, `LECTIC_CACHE`, `LECTIC_STATE`,
  `LECTIC_TEMP`, and `LECTIC_FILE` (when using `-f` or `-i`). Your shell
  environment is also passed through.
- Macro expansions can inject additional variables into `exec:` via
  directive attributes. See the [Macros
  guide](../automation/01_macros.qmd) for details.

## Behavior and errors

- The value is recomputed on each run. This makes it easy to incorporate
  recent state (for example, “memory” from a local database) into a
  prompt.
- If a file cannot be read or a command fails, Lectic reports an error
  and aborts the run. Fix the source and try again.

See also

- [External Content](./01_external_content.qmd) for attaching files to
  user messages.
- [Macros](../automation/01_macros.qmd) for passing variables into
  `exec:` expansions within macros.



# Recipe: Coding Assistant

This recipe shows how to set up an agentic coding assistant with shell
tools, type checking, and a confirmation dialog before tool execution.

## The Setup

We’ll give the assistant access to:

- File reading and writing
- Running TypeScript compiler and linter
- Executing shell commands (with confirmation)

### Configuration

Create a `lectic.yaml` in your project root:

``` yaml
interlocutor:
  name: Assistant
  prompt: |
    You are a senior software engineer helping with this codebase.
    
    When making changes:
    1. Read relevant files first to understand context
    2. Make minimal, focused changes
    3. Run tsc and eslint after edits to catch errors
    4. Explain your reasoning
  provider: anthropic
  model: claude-sonnet-4-20250514
  tools:
    - exec: cat
      name: read_file
      usage: Read a file. Pass the file path as an argument.
    - name: write_file
      usage: Write content to a file. 
      exec: |
        #!/bin/bash
        cat > "$FILE_PATH"
      schema:
        FILE_PATH: The path to write to.
        CONTENT: The content to write (passed via stdin).
    - exec: tsc --noEmit
      name: typecheck
      usage: Run the TypeScript compiler to check for type errors.
    - exec: eslint
      name: lint
      usage: Run ESLint on files. Pass file paths as arguments.
    - exec: bash -c
      name: shell
      usage: Run a shell command. Use for git, grep, find, etc.

hooks:
  - on: tool_use_pre
    do: ~/.config/lectic/confirm.sh
```

### The Confirmation Script

For graphical environments, create `~/.config/lectic/confirm.sh`:

``` bash
#!/bin/bash
# Requires: zenity (GTK) or kdialog (KDE)

# Skip confirmation for read-only tools
case "$TOOL_NAME" in
  read_file|typecheck|lint)
    exit 0
    ;;
esac

# Show confirmation dialog
zenity --question \
  --title="Allow tool use?" \
  --text="Tool: $TOOL_NAME\n\nArguments:\n$TOOL_ARGS" \
  --width=400

exit $?
```

Make it executable: `chmod +x ~/.config/lectic/confirm.sh`

> [!NOTE]
>
> The confirmation hook runs as a subprocess without access to a
> terminal, so interactive terminal prompts (like `read -p`) won’t work.
> Use a GUI dialog tool like `zenity`, `kdialog`, or `osascript` on
> macOS.

## Usage

Create a conversation file in your project:

``` markdown
---
# Uses lectic.yaml from project root
---

I need to add input validation to the `processUser` function in 
src/users.ts. It should reject empty names and invalid email formats.
```

Run it:

``` bash
lectic -i task.lec
```

The assistant will:

1.  Read `src/users.ts` to understand the current implementation
2.  Propose changes (you’ll see a confirmation dialog for writes)
3.  Run `tsc` and `eslint` to verify the changes
4.  Report results

## Variations

### Read-only assistant

Remove write and shell tools for a safer setup that can only read and
analyze:

``` yaml
tools:
  - exec: cat
    name: read_file
  - exec: rg --json
    name: search
    usage: Search with ripgrep. Pass pattern and optional path.
  - exec: tsc --noEmit
    name: typecheck
```

### With sandboxing

For stronger isolation, use the bubblewrap sandbox included in the
repository at `extra/sandbox/bwrap-sandbox.sh`:

``` yaml
tools:
  - exec: bash -c
    name: shell
    sandbox: ./extra/sandbox/bwrap-sandbox.sh
```

The sandbox script uses
[Bubblewrap](https://github.com/containers/bubblewrap) to run commands
in an isolated environment. It:

- Creates a temporary home directory that’s discarded after execution
- Mounts the current working directory read-write
- Provides read-only access to essential system paths (`/usr`, `/bin`,
  etc.)
- Blocks network access by default

You can copy the script to your config directory and modify it to suit
your needs — for example, to allow network access or mount additional
paths.

### Notification on completion

Add a hook to notify you when the assistant finishes working:

``` yaml
hooks:
  - on: tool_use_pre
    do: ~/.config/lectic/confirm.sh
  - on: assistant_message
    do: |
      #!/bin/bash
      if [[ "$TOOL_USE_DONE" == "1" ]]; then
        notify-send "Lectic" "Task complete"
      fi
```



# Recipe: Git Commit Messages

This recipe creates a custom `lectic commit` subcommand that generates
commit messages from your staged changes.

## The Subcommand

Lectic looks for executables named `lectic-<command>` in your config
directory, data directory, or PATH. Create
`~/.config/lectic/lectic-commit`:

``` bash
#!/bin/bash
set -euo pipefail

# Check for staged changes
if git diff --cached --quiet; then
  echo "No staged changes" >&2
  exit 1
fi

lectic -f ~/.config/lectic/commit-prompt.lec -S
```

Make it executable:

``` bash
chmod +x ~/.config/lectic/lectic-commit
```

## The Prompt Template

Create `~/.config/lectic/commit-prompt.lec`:

``` markdown
---
interlocutor:
  name: Assistant
  prompt: |
    You write git commit messages following the Conventional Commits
    specification. Output ONLY the commit message, nothing else.
    
    Format:
    <type>[optional scope]: <description>
    
    [optional body]
    
    Types: feat, fix, docs, style, refactor, perf, test, chore
    
    Rules:
    - Subject line max 50 characters
    - Use imperative mood ("add" not "added")
    - Body wraps at 72 characters
    - Explain what and why, not how
  provider: anthropic
  model: claude-3-haiku-20240307
  max_tokens: 500
---

Write a commit message for this diff:

:cmd[git diff --cached]
```

The `:cmd[git diff --cached]` directive runs `git diff --cached` and
includes the output in the context sent to the LLM.

## Usage

Stage your changes and run:

``` bash
git add -p
lectic commit
```

Output:

    feat(auth): add password strength validation

    Implement zxcvbn-based password strength checking during registration.
    Reject passwords scoring below 3 and display feedback to users.

### Pipe directly to git

``` bash
lectic commit | git commit -F -
```

### Interactive edit before commit

``` bash
lectic commit | git commit -eF -
```

## Variations

### Include recent commits for context

Modify the prompt to show recent history:

``` markdown
Recent commits for context:
:cmd[git log --oneline -5]

Write a commit message for this diff:
:cmd[git diff --cached]
```

### Different styles

Create multiple prompt files for different projects:

- `commit-prompt-conventional.lec` — Conventional Commits
- `commit-prompt-gitmoji.lec` — Gitmoji style
- `commit-prompt-simple.lec` — Plain descriptions

Then modify the subcommand to accept an argument:

``` bash
#!/bin/bash
set -euo pipefail

STYLE="${1:-conventional}"
PROMPT="$HOME/.config/lectic/commit-prompt-$STYLE.lec"

if [[ ! -f "$PROMPT" ]]; then
  echo "Unknown style: $STYLE" >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "No staged changes" >&2
  exit 1
fi

lectic -f "$PROMPT" -S
```

Usage: `lectic commit gitmoji`

### Batch mode for multiple commits

Generate messages for each file separately:

``` bash
#!/bin/bash
for file in $(git diff --cached --name-only); do
  echo "=== $file ==="
  # Create a temporary prompt with just this file's diff
  cat > /tmp/commit-single.lec << EOF
---
interlocutor:
  name: Assistant
  prompt: Write a conventional commit message for this change. Output only the message.
  model: claude-3-haiku-20240307
  max_tokens: 200
---

:cmd[git diff --cached -- "$file"]
EOF
  lectic -f /tmp/commit-single.lec -S
  echo
done
```



# Recipe: Research with Multiple Perspectives

This recipe shows how to use multiple interlocutors to explore a topic
from different angles. One interlocutor does research, another provides
critique, and you can quickly get second opinions without derailing the
main conversation.

## The Setup

``` yaml
---
interlocutors:
  - name: Researcher
    prompt: |
      You are a thorough researcher. When exploring a topic:
      - Consider multiple sources and viewpoints
      - Note uncertainties and limitations
      - Suggest follow-up questions
    provider: anthropic
    model: claude-sonnet-4-20250514
    tools:
      - native: search
      - think_about: >
          What are the key questions here? What might I be missing?
          What assumptions am I making?

  - name: Critic  
    prompt: |
      You are a skeptical critic. Your job is to:
      - Challenge assumptions and weak arguments
      - Point out missing evidence or alternative explanations
      - Steelman opposing viewpoints
      Be constructive but rigorous.
    provider: anthropic
    model: claude-sonnet-4-20250514

  - name: Synthesizer
    prompt: |
      You synthesize discussions into clear summaries. Focus on:
      - Key points of agreement and disagreement
      - Open questions that remain
      - Actionable conclusions
    provider: anthropic
    model: claude-3-haiku-20240307
---
```

## Usage

### Start with research

``` markdown
:ask[Researcher] I'm trying to understand the tradeoffs between
microservices and monolithic architectures for a team of 5 developers
building a B2B SaaS product.
```

The Researcher will explore the topic, potentially using web search and
their thinking tool.

### Get a quick critique

Use `:aside` to get feedback without switching the main conversation:

``` markdown
:aside[Critic] What's wrong with this analysis?
```

The Critic responds, then the next message goes back to the Researcher
automatically.

### Permanently switch for deeper critique

``` markdown
:ask[Critic] Let's dig into the claim about "complexity tax." What's
the actual evidence here?
```

Now you’re in a conversation with the Critic until you switch again.

### Synthesize at the end

``` markdown
:ask[Synthesizer] Summarize this discussion. What did we learn? What
should we do next?
```

## Variations

### Domain-specific experts

``` yaml
interlocutors:
  - name: Legal
    prompt: You are a legal expert. Focus on regulatory compliance...
  - name: Technical
    prompt: You are a senior engineer. Focus on implementation...
  - name: Business
    prompt: You are a business strategist. Focus on market fit...
```

### Agent delegation

Have one interlocutor call another as a tool:

``` yaml
interlocutors:
  - name: Lead
    prompt: You coordinate research. Delegate to specialists.
    tools:
      - agent: Researcher
        name: research
        usage: Get detailed research on a specific topic.
      - agent: Critic
        name: critique
        usage: Get critical analysis of a claim or argument.
  
  - name: Researcher
    prompt: ...
    tools:
      - native: search
  
  - name: Critic
    prompt: ...
```

Now the Lead can autonomously decide when to delegate:

``` markdown
:ask[Lead] Evaluate whether we should migrate from PostgreSQL to
CockroachDB for our multi-region deployment.
```

### Different models for different roles

Use cheaper/faster models for quick checks:

``` yaml
interlocutors:
  - name: Deep
    model: claude-sonnet-4-20250514  # For complex analysis
    
  - name: Quick
    model: claude-3-haiku-20240307  # For quick sanity checks
```

## Tips

- **Use `:aside` liberally.** It’s cheap to get a second opinion without
  losing your place in the main conversation.

- **Give each interlocutor a distinct voice.** The prompts should
  produce noticeably different responses, otherwise there’s no point in
  having multiple speakers.

- **Use `:reset[]` when switching topics.** If you’re starting a new
  line of inquiry, reset context to avoid confusion from earlier
  discussion.



# Recipe: Conversation Memory

This recipe shows two approaches to giving your assistant memory across
conversations: explicit recall via a tool, and automatic context via
hooks. These serve different purposes and have different tradeoffs.

## Approach 1: Memory as a Tool

In this approach, everything is recorded automatically, but the
assistant must explicitly search for relevant memories. This keeps the
prompt lean and preserves cache efficiency.

### The Recording Hook

Add this hook to save every message:

``` yaml
hooks:
  - on: [user_message, assistant_message]
    do: |
      #!/bin/bash
      set -euo pipefail
      
      DB="${LECTIC_DATA}/memory.sqlite3"
      
      # Initialize database if needed
      sqlite3 "$DB" <<'SQL'
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        role TEXT NOT NULL,
        interlocutor TEXT,
        file TEXT,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      SQL
      
      # Determine role and content
      if [[ -n "${ASSISTANT_MESSAGE:-}" ]]; then
        ROLE="assistant"
        CONTENT="$ASSISTANT_MESSAGE"
        NAME="${LECTIC_INTERLOCUTOR:-}"
      else
        ROLE="user"
        CONTENT="${USER_MESSAGE:-}"
        NAME=""
      fi
      
      # Escape single quotes for SQL
      CONTENT_ESC="${CONTENT//\'/\'\'}"
      NAME_ESC="${NAME//\'/\'\'}"
      FILE_ESC="${LECTIC_FILE//\'/\'\'}"
      
      sqlite3 "$DB" <<SQL
      INSERT INTO messages (timestamp, role, interlocutor, file, content)
      VALUES (datetime('now'), '$ROLE', '$NAME_ESC', '$FILE_ESC', '$CONTENT_ESC');
      SQL
```

### The Search Tool

Give the assistant a tool to search memory:

``` yaml
tools:
  - name: search_memory
    usage: |
      Search past conversation history. Use this when the user
      references something from a previous conversation or when
      context from past discussions would be helpful.
    exec: |
      #!/bin/bash
      sqlite3 "${LECTIC_DATA}/memory.sqlite3" <<SQL
      SELECT printf('[%s] %s: %s', timestamp, role, content)
      FROM messages
      WHERE content LIKE '%${QUERY}%'
      ORDER BY timestamp DESC
      LIMIT 10;
      SQL
    schema:
      QUERY: The search term to look for in past messages.
```

### When to Use This

- Long-running assistants where most turns don’t need memory
- When you want the assistant to decide what’s relevant
- When cache efficiency matters (the prompt stays constant)

## Approach 2: Automatic Context Injection

In this approach, relevant memories are automatically injected into
every prompt. Nothing is recorded automatically — instead, the assistant
has a tool to explicitly remember things.

### The Remember Tool

``` yaml
tools:
  - name: remember
    usage: |
      Store important information for future reference. Use this when
      the user shares preferences, makes decisions, or provides context
      that should persist across conversations.
    exec: |
      #!/bin/bash
      set -euo pipefail
      
      DB="${LECTIC_DATA}/memory.sqlite3"
      
      sqlite3 "$DB" <<'SQL'
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL
      );
      SQL
      
      CONTENT_ESC="${CONTENT//\'/\'\'}"
      
      sqlite3 "$DB" <<SQL
      INSERT INTO memories (timestamp, content)
      VALUES (datetime('now'), '$CONTENT_ESC');
      SQL
      
      echo "Remembered."
    schema:
      CONTENT: The information to remember.
```

### The Prompt with Memory

Use an `exec:` prompt to inject stored memories:

``` yaml
interlocutor:
  name: Assistant
  prompt: |
    exec:#!/bin/bash
    cat <<'PROMPT'
    You are a helpful assistant with access to stored memories.
    
    Things you've been asked to remember:
    PROMPT
    
    DB="${LECTIC_DATA}/memory.sqlite3"
    if [[ -f "$DB" ]]; then
      sqlite3 "$DB" <<'SQL'
      SELECT printf('- %s', content)
      FROM memories
      ORDER BY timestamp DESC
      LIMIT 20;
      SQL
    else
      echo "(No memories yet)"
    fi
    
    echo ""
    echo "Use the remember tool to store new information."
```

### When to Use This

- When you want explicit control over what’s remembered
- For preferences and decisions rather than conversation history
- When memories are small and frequently relevant

## Tips

- **Don’t mix these approaches carelessly.** Recording everything *and*
  injecting it into the prompt will bloat your context and hurt cache
  performance.

- **Be selective about what you store.** Tool call results and verbose
  outputs can bloat the database quickly.

- **Consider privacy.** Memory persists across sessions. Don’t store
  sensitive information you wouldn’t want retrieved later.

- **Monitor database size.** Add a periodic cleanup job or a `forget`
  tool for manual pruning.

### A Simple Forget Tool

``` yaml
tools:
  - name: forget
    usage: Remove a specific memory by its content.
    exec: |
      #!/bin/bash
      sqlite3 "${LECTIC_DATA}/memory.sqlite3" <<SQL
      DELETE FROM memories WHERE content LIKE '%${PATTERN}%';
      SELECT 'Deleted ' || changes() || ' memories';
      SQL
    schema:
      PATTERN: Pattern to match memories to delete.
```



# Recipe: Context Compaction

This recipe shows how to automatically handle long conversations by
summarizing and resetting context when token usage gets high.

## The Problem

Long conversations hit context limits. Before that happens, you want to:

1.  Summarize what’s been discussed
2.  Reset the context window
3.  Continue with the summary as the new starting point

## Automatic Compaction Hook

This hook monitors token usage and triggers compaction when a threshold
is reached:

``` yaml
hooks:
  - on: assistant_message
    inline: true
    do: |
      #!/bin/bash
      
      # Configuration
      LIMIT=80000        # Trigger compaction at this token count
      
      TOTAL="${TOKEN_USAGE_TOTAL:-0}"
      
      if [[ $TOTAL -lt $LIMIT ]]; then
        exit 0  # No output, no action
      fi
      
      # The conversation body comes in on stdin.
      # Indent it as a code block for the summarizer.
      CONVERSATION=$(sed 's/^/    /')
      
      # Generate summary using a separate lectic call
      SUMMARY=$(echo "$CONVERSATION" | lectic -f ~/.config/lectic/summarize.lec -S)
      
      # Output with reset header
      echo "LECTIC:reset"
      echo "LECTIC:final"
      echo ""
      echo "**Context compacted at $TOTAL tokens.**"
      echo ""
      echo "Summary of previous discussion:"
      echo "$SUMMARY"
```

The `LECTIC:reset` header clears prior context. The `LECTIC:final`
header prevents the assistant from responding to the compaction notice
itself.

## The Summarization Prompt

Create `~/.config/lectic/summarize.lec`:

``` markdown
---
interlocutor:
  name: Summarizer
  prompt: |
    Summarize the following conversation concisely. Include:
    - Key decisions made
    - Important information established
    - Current task or question being addressed
    - Any pending items or open threads
    
    Be thorough but concise. This summary will be the only context
    available for continuing the conversation.
  model: claude-3-haiku-20240307
  max_tokens: 1000
---

Summarize this conversation:
```

The conversation text is piped to stdin and appended to the prompt
file’s content.

## How It Works

1.  After each assistant message, the hook checks `TOKEN_USAGE_TOTAL`
2.  The conversation body so far is available on stdin
3.  If over the limit, the hook pipes the conversation to a separate
    lectic instance for summarization
4.  The summary is output with the `reset` header, clearing old context
5.  The next turn starts fresh with only the summary as context

## Variations

### Manual compaction trigger

Instead of automatic triggering, add a macro:

``` yaml
macros:
  - name: compact
    expansion: |
      exec:#!/bin/bash
      echo ":reset[]"
      echo ""
      echo "Please summarize our conversation so far, focusing on key"
      echo "decisions, important context, and any open questions."
```

Usage: `:compact[]`

This asks the current assistant to summarize before resetting, rather
than using a separate summarization call.

### Archive before compacting

Save the full conversation before resetting:

``` yaml
hooks:
  - on: assistant_message
    inline: true
    do: |
      #!/bin/bash
      TOTAL="${TOKEN_USAGE_TOTAL:-0}"
      LIMIT=80000
      
      if [[ $TOTAL -lt $LIMIT ]]; then
        exit 0
      fi
      
      # Archive the current conversation
      ARCHIVE_DIR="${LECTIC_DATA}/archives"
      mkdir -p "$ARCHIVE_DIR"
      
      TIMESTAMP=$(date +%Y%m%d-%H%M%S)
      BASE=$(basename "${LECTIC_FILE:-.lec}" .lec)
      ARCHIVE_FILE="$ARCHIVE_DIR/$BASE-$TIMESTAMP.lec"
      
      # Save stdin (the conversation) to the archive
      cat > "$ARCHIVE_FILE"
      
      # Now generate summary (re-read from archive since stdin is consumed)
      SUMMARY=$(sed 's/^/    /' "$ARCHIVE_FILE" | \
                lectic -f ~/.config/lectic/summarize.lec -S)
      
      echo "LECTIC:reset"
      echo "LECTIC:final"
      echo ""
      echo "**Context compacted. Archived to: $ARCHIVE_FILE**"
      echo ""
      echo "Summary:"
      echo "$SUMMARY"
```

### Warning before compaction

Give a warning at 70% capacity, compact at 90%:

``` yaml
hooks:
  - on: assistant_message
    inline: true
    do: |
      #!/bin/bash
      TOTAL="${TOKEN_USAGE_TOTAL:-0}"
      WARN_LIMIT=70000
      HARD_LIMIT=90000
      
      if [[ $TOTAL -gt $HARD_LIMIT ]]; then
        # Full compaction
        CONVERSATION=$(sed 's/^/    /')
        SUMMARY=$(echo "$CONVERSATION" | \
                  lectic -f ~/.config/lectic/summarize.lec -S)
        echo "LECTIC:reset"
        echo "LECTIC:final"
        echo ""
        echo "**Context limit reached. Compacted.**"
        echo ""
        echo "$SUMMARY"
      elif [[ $TOTAL -gt $WARN_LIMIT ]]; then
        # Just warn
        cat > /dev/null  # Consume stdin
        echo "LECTIC:final"
        echo ""
        echo "*Note: Context at ${TOTAL} tokens. Consider* :reset[] *soon.*"
      fi
```

## Tips

- **Test your summarizer.** A bad summary loses important context. Try
  it manually on a few conversations first.

- **Use a fast model for summarization.** Haiku or similar is fine for
  summaries and keeps compaction quick.

- **Consider what to preserve.** Code snippets, file paths, and specific
  decisions are often more important than general discussion.

- **Monitor compaction frequency.** If you’re compacting every few
  messages, your conversations might be too verbose or you might need a
  larger context model.



# Recipe: Custom Sandboxing

Giving an LLM access to `exec` tools is powerful, but it carries risk.
While Lectic provides a `sandbox` configuration option, it doesn’t
enforce a specific technology. Instead, it delegates execution to a
script you control.

This recipe walks you through the sandbox script mechanism and helps you
write wrappers to isolate tool execution.

## The Sandbox Protocol

When you configure a `sandbox` in your `lectic.yaml`, Lectic wraps the
execution of `exec` tools and local `mcp_command` tools. Instead of
executing the tool directly, it executes your sandbox script and passes
the tool’s command and arguments as arguments to that script.

**An exec tool without sandbox:** Lectic runs: `ls -la`

**With `sandbox: ./wrapper.sh`:** Lectic runs: `./wrapper.sh ls -la`

The command to launch an MCP server is wrapped by the sandbox script in
a similar way.

Your sandbox script is responsible for:

1.  Setting up the environment.
2.  Executing the command (passed in `$@`).
3.  Cleaning up.
4.  Returning the exit code.

## Level 1: Observability Wrapper

Before trying to isolate the filesystem, let’s make a wrapper that
simply logs every command the assistant tries to run. This is useful for
auditing.

Create `~/.config/lectic/audit.sh`:

``` bash
#!/bin/bash
# Append timestamp and command to a log file
echo "[$(date)] Executing: $*" >> "$HOME/.lectic_audit_log"

# Run the actual command
exec "$@"
```

Make it executable:

``` bash
chmod +x ~/.config/lectic/audit.sh
```

Configure it in `lectic.yaml`:

``` yaml
interlocutor:
  name: Assistant
  # Apply to all exec/local MCP tools for this interlocutor
  sandbox: ~/.config/lectic/audit.sh
  tools:
    - exec: ls
```

## Level 2: Filesystem Isolation (Bubblewrap)

For actual safety, we can use
[Bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). This
tool creates a new namespace for the process, allowing you to control
exactly which parts of your filesystem the assistant can see or write
to.

Here is a simplified version of the `lectic-bwrap` script found in the
Lectic repository. It creates a read-only view of the system but gives
the assistant a temporary, empty home directory.

Create `~/.config/lectic/safe-run.sh`:

``` bash
#!/bin/bash
set -euo pipefail

# Create a temporary directory for the assistant's "home"
FAKE_HOME=$(mktemp -d)

# Ensure we clean up the temp dir when the script exits
trap 'rm -rf "$FAKE_HOME"' EXIT

# Run bwrap with specific permissions
bwrap \
  --ro-bind / / \                 # Mount the root as read-only
  --dev /dev \                    # legitimate devices
  --proc /proc \                  # legitimate processes
  --bind "$PWD" "$PWD" \          # Allow read-write access to current project
  --bind "$FAKE_HOME" "$HOME" \   # Fake the home directory
  --unshare-net \                 # Disable network access (optional)
  --die-with-parent \             # Kill process if lectic dies
  "$@"
```

### How this protects you

1.  **Read-only Root**: The assistant cannot modify system files
    (`/usr`, `/bin`, etc.).
2.  **Fake Home**: If the assistant runs `rm -rf ~`, it only deletes the
    temporary directory, not your actual home folder.
3.  **Project Access**: The script explicitly binds `$PWD`, so the
    assistant can still read and write files in the directory where you
    ran Lectic.
4.  **No Network**: The `--unshare-net` flag prevents the assistant from
    making outbound connections (remove this if you want it to use
    `curl` or something similar).

## Level 3: Stateful Isolation (The “Shadow Workspace”)

Isolating the filesystem by copying the project to a temporary directory
is a great way to protect your work. However, simple scripts that create
a new directory for every command will break stateful workflows (e.g.,
`git init` followed by `git commit` won’t work if they run in different
directories).

To fix this, we need a **stateful sandbox** that persists across tool
calls. We can use environment variables provided by Lectic to identify
the session.

Create `~/.config/lectic/shadow-run.sh`:

``` bash
#!/bin/bash
set -euo pipefail

# 1. Generate a stable path for this project + interlocutor
# Using a hash of the current directory ensures we get a unique sandbox per project
PROJ_HASH=$(echo -n "$PWD" | md5sum | awk '{print $1}')
SANDBOX_ROOT="${TMPDIR:-/tmp}/lectic-sandbox-${PROJ_HASH}"
# LECTIC_INTERLOCUTOR is provided by Lectic
SANDBOX_DIR="$SANDBOX_ROOT/${LECTIC_INTERLOCUTOR:-default}"

# 2. Initialize the sandbox if it's new
if [[ ! -d "$SANDBOX_DIR" ]]; then
  echo "Initializing sandbox at $SANDBOX_DIR..." >&2
  mkdir -p "$SANDBOX_DIR"
  # Copy the project to the sandbox
  cp -r . "$SANDBOX_DIR"
fi

cd "$SANDBOX_DIR"

# 3. Run the command
"$@"
```

This script creates a “shadow” copy of your project that persists as
long as you don’t delete the temporary directory. The assistant can make
changes, run builds, and edit files without affecting your real project.
If you like the results, you can manually copy them back.

## Configuration Usage

You can apply sandboxes project-wide (top-level), per-interlocutor, or
per- tool.

Precedence is:

1.  Tool `sandbox`
2.  Interlocutor `sandbox`
3.  Top-level `sandbox`

**Project-wide default (recommended for per-project configs):** This
wraps all `exec` tools and local `mcp_command` tools in the project,
across all interlocutors.

``` yaml
sandbox: ~/.config/lectic/safe-run.sh

interlocutor:
  name: Assistant
  tools:
    - exec: bash
    - exec: python3
```

**Per-interlocutor default:** Useful when different interlocutors need
different isolation.

``` yaml
interlocutor:
  name: Assistant
  sandbox: ~/.config/lectic/safe-run.sh
  tools:
    - exec: bash
    - exec: python3
```

**Per-tool:** Useful if you have a specific “dangerous” tool that needs
isolation while others (like `ls`) can run natively.

``` yaml
tools:
  - exec: rm
    name: delete_files
    sandbox: ~/.config/lectic/safe-run.sh
  - exec: ls
    name: list_files
    # No sandbox
```

## Tips

- **Environment variables**: Lectic passes variables like
  `LECTIC_INTERLOCUTOR` into sandboxed commands. Use these for
  per-interlocutor state (for example, separate scratch directories).
  See [Exec Tool](../tools/02_exec.qmd#execution-environment) and
  [Configuration
  Reference](../reference/02_configuration.qmd#overriding-default-directories).

- **Quoting and arguments**: A sandbox is a command string. If you need
  complex quoting or structured options, prefer writing a wrapper
  script.

- **Performance matters**: Tools can be called in tight loops. Heavy
  sandboxes like `docker run` can add significant latency. Prefer
  `docker exec` into a long-running container if you go the Docker
  route.

- **Test your sandbox**: Verify it blocks what you think it blocks. Try
  to access files outside the allowed roots and confirm it fails.



# Control Flow with Macros

> [!NOTE]
>
> ### Advanced Recipe
>
> This recipe demonstrates advanced macro techniques. Most Lectic
> workflows don’t need recursive macros or control flow constructs—a
> simple `exec` tool or script usually suffices. But if you want to see
> how far the macro system can go, read on.

Because Lectic’s macros support recursion and can execute scripts during
the expansion phase, it is possible to build powerful control flow
structures like conditionals, loops, and maps.

This guide demonstrates how to implement these constructs. While complex
logic is often better handled by writing a custom tool or script, these
examples show the flexibility of the macro system.

## The Mechanism: Recursion + `pre`

The key to control flow is the `pre` phase of macro expansion. (See
[Automation:
Macros](../automation/01_macros.qmd#advanced-macros-phases-and-recursion)).

Because the result of a `pre` expansion is itself recursively expanded,
a macro can return a new instance of itself with different arguments,
effectively creating a loop.

Additionally, because `pre` expansions can run shell scripts (`exec:`),
they can make decisions based on arguments or environment variables.

## Recipe 1: Conditional (`:if`)

A simple conditional macro evaluates a condition and outputs either its
content (the “then” block) or an alternative (the “else” block).

**Definition:**

``` yaml
macros:
  - name: if
    post: |
      exec:#!/bin/bash
      if [ "$ARG" = "true" ]; then
        echo "$THEN"
      else
        echo "$ELSE"
      fi
```

**Usage:**

``` markdown
:if[true]{THEN="This is displayed if true" ELSE="This is displayed if false"}
:if[false]{THEN="This is hidden if not true" ELSE="This is shown instead"}
:if[:some_check[]]{THEN="This is hidden if not true" ELSE="This is shown instead"}
```

## Recipe 2: Short-circuiting Conditional (`:when`)

The previous example required passing the content as attributes
(`THEN="..."`), which is clumsy for large blocks of text. More
importantly, if we want to conditionally run a command, we need to
prevent it from executing at all unless the condition is met.

If we use the `post` phase, the children are expanded *before* the
parent macro. To achieve “short-circuiting” (where the children are only
expanded if the condition is true), we can use the `pre` phase of macro
expansion.

**Definition:**

``` yaml
macros:
  - name: when
    # In the 'pre' phase, ARG contains the raw, unexpanded body text.
    pre: |
      exec:#!/bin/bash
      if [ "$CONDITION" = "true" ]; then
        # Return the body to be expanded
        echo "$ARG"
      else
        # Return a comment (effectively deleting the block)
        echo "<!-- skipped -->"
      fi
```

**Usage:**

``` markdown
:when[
  This content is only processed if the condition is met.
  :cmd[echo "Expensive operation running..."]
]{CONDITION="false"}
```

In this example the expensive `:cmd` is never expanded or executed.

## Recipe 3: Recursion & Loops (`:countdown`)

By having a macro call itself, we can create loops. We need a
termination condition to stop the recursion (preventing an infinite
loop).

**Definition:**

``` yaml
macros:
  - name: countdown
    pre: |
      exec:#!/bin/bash
      N=${ARG:-10}
      if [ "$N" -gt 0 ]; then
        echo "$N..."
        # Recursive call with N-1
        echo ":countdown[$((N-1))]"
      else
        echo "Liftoff!"
      fi
```

**Usage:**

``` markdown
:countdown[3]
```

**Output:**

``` text
3...
2...
1...
Liftoff!
```

## Recipe 4: Iteration (`:map`)

We can iterate over a list of items and apply another macro to each one.
This is useful for batch processing files, names, or data.

This implementation assumes a space-separated list of items.

**Definition:**

``` yaml
macros:
  - name: map
    pre: |
      exec:#!/bin/bash
      # Split ARG into array (space separated)
      items=($ARG)
      
      # Termination: if no items, stop
      if [ ${#items[@]} -eq 0 ]; then
          echo "<!-- -->"
          exit 0
      fi
      
      # Head: The first item
      first=${items[0]}
      
      # Tail: The rest of the items
      rest=${items[@]:1}
      
      # 1. Apply the target macro to the first item
      echo ":$MACRO[$first]"
      
      # 2. Recurse on the rest (if any)
      if [ -n "$rest" ]; then
         echo ":map[$rest]{MACRO=$MACRO}"
      fi
```

**Usage:**

Suppose you have a macro `greet` defined:

``` yaml
macros:
  - name: greet
    expansion: "Hello, $ARG! "
```

You can map it over a list of names:

``` markdown
:map[Alice Bob Charlie]{MACRO="greet"}
```

**Output:**

``` text
Hello, Alice! Hello, Bob! Hello, Charlie! 
```

## Fun Example: The “Launch Sequence”

Let’s combine these concepts into a “Launch Sequence” generator. We want
to check a list of systems, and if they are all go, initiate a
countdown.

**Configuration:**

``` yaml
macros:
  - name: launch_sequence
    expansion: |
      # Check systems
      :map[Propulsion Guidance Life-Support]{MACRO="check_system"}
      
      # Start countdown
      :countdown[5]

  - name: check_system
    expansion: "Checking $ARG... OK.\n"

  - name: map
    pre: |
      exec:#!/bin/bash
      items=($ARG)
      if [ ${#items[@]} -eq 0 ]; then echo "<!-- -->"; exit 0; fi
      first=${items[0]}
      rest=${items[@]:1}
      echo ":$MACRO[$first]"
      if [ -n "$rest" ]; then echo ":map[$rest]{MACRO=$MACRO}"; fi

  - name: countdown
    pre: |
      exec:#!/bin/bash
      N=${ARG:-10}
      if [ "$N" -gt 0 ]; then
        echo "$N..."
        echo ":countdown[$((N-1))]"
      else
        echo "Liftoff!"
      fi
```

**Usage:**

``` markdown
:launch_sequence[]
```

**Output:**

``` text
Checking Propulsion... OK.
Checking Guidance... OK.
Checking Life-Support... OK.
5...
4...
3...
2...
1...
Liftoff!
```

> [!NOTE]
>
> ### Recursion Limit
>
> Lectic has a recursion depth limit (default 100) to prevent infinite
> loops from crashing the process. If your loop needs to run more than
> 100 times, you should probably use an external script (`exec:`)
> instead of a recursive macro.



# Recipe: Agent Skills Support

This recipe adds support for the [Agent Skills](https://agentskills.io)
format by building a custom `lectic skills` subcommand.

## What are Agent Skills?

[Agent Skills](https://agentskills.io) is an open format for packaging
reusable capabilities that LLMs can load on demand. A skill is a folder
containing:

- `SKILL.md`: Instructions for the LLM (with YAML frontmatter for
  metadata)
- `scripts/`: Executable scripts the LLM can run
- `references/`: Documentation and examples the LLM can read

The format emphasizes “progressive disclosure”—the LLM sees only skill
names and descriptions initially, then loads full instructions only when
needed. This keeps prompts small while giving the LLM access to a large
library of capabilities.

## Goal

We’ll build a subcommand that gives your LLM access to a library of
skills while keeping the base prompt small. It follows the skills spec’s
“progressive disclosure” approach:

1.  Discovery: load only each skill’s name + description.
2.  Activation: load the full `SKILL.md` instructions for one skill.
3.  Resources: read reference files or run scripts only when needed.

## The subcommand

Lectic resolves `lectic <command>` using git-style subcommands. We will
create an executable named `lectic-skills.ts` (TypeScript), using
Lectic’s built-in script runner (`lectic script`).

Copy the repository’s `extra/lectic-skills.ts` to your config directory:

``` bash
cp /path/to/lectic/extra/lectic-skills.ts ~/.config/lectic/lectic-skills.ts
chmod +x ~/.config/lectic/lectic-skills.ts
```

Now `lectic skills` should resolve to that file.

## Skill directories

The subcommand accepts one or more “skill directory” paths.

Each path may be either:

- A single skill root (it contains `SKILL.md`)
- A directory that contains multiple skill roots as immediate children

Example layout:

``` text
skills/
  pdf-processing/
    SKILL.md
    scripts/
    references/
  code-review/
    SKILL.md
```

## Configure it as an exec tool

Add an exec tool that bakes in the skill directories:

``` yaml
tools:
  - name: skills
    exec: lectic skills ./skills $LECTIC_DATA/skills
    usage: exec:lectic skills --prompt ./skills $LECTIC_DATA/skills
```

This creates a single tool (named `skills`) that the model can use to:

- `activate <name>` (load instructions)
- `read <name> <path>` (load reference content)
- `run <name> <script> ...` (execute bundled scripts)

The discovery list (name + description for each skill) is included in
the tool usage text generated by `--prompt`, so the model usually does
not need to call `list`.

## Example workflow

1.  The model activates a skill when relevant:

``` text
<tool-call with="skills">
<arguments><argv>["activate","pdf-processing"]</argv></arguments>
...</tool-call>
```

3.  It reads references mentioned by `SKILL.md`:

``` text
<tool-call with="skills">
<arguments><argv>["read","pdf-processing","references/REFERENCE.md"]</argv></arguments>
...</tool-call>
```

4.  It runs a script bundled with the skill:

``` text
<tool-call with="skills">
<arguments><argv>["run","pdf-processing","extract.py","--input","a.pdf"]</argv></arguments>
...</tool-call>
```

## How it’s built

The subcommand is a small CLI wrapper around the skills folder format:

- It scans the provided directories for `SKILL.md` files.
- It parses the YAML frontmatter to build the discovery list.
- `activate` returns the full skill instructions on demand.
- `read` enforces path containment (no `..` escapes) and has a size cap.
- `run` executes files in `scripts/` only, with the skill root as the
  working directory.

## Safety notes

Running skill scripts is equivalent to granting the LLM another `exec`
tool. In real use, you should combine this with one or more of:

- A `tool_use_pre` confirmation hook
- A sandbox wrapper (Bubblewrap, nsjail, etc.)

See [Custom Sandboxing](./06_custom_sandboxing.qmd) for practical
options.



# Cookbook

This section contains practical recipes showing how to combine Lectic’s
primitives to build useful workflows. Each recipe is self-contained and
can be adapted to your needs.

## Getting Started

If you’re new to Lectic, start with these:

- **[Coding Assistant](./01_coding_assistant.qmd)** — Give your LLM
  shell access, type checking, and linting. Includes a confirmation
  dialog so you approve tool calls before they run.

- **[Git Commit Messages](./02_commit_messages.qmd)** — A
  `lectic commit` subcommand that generates conventional commit messages
  from your staged changes. A good example of building small, focused
  tools.

## Multi-Agent Workflows

- **[Research with Multiple
  Perspectives](./03_research_perspectives.qmd)** — Define multiple
  interlocutors with different personalities (researcher, critic,
  synthesizer) and use `:ask` and `:aside` to get different viewpoints
  on a problem.

## State and Memory

- **[Conversation Memory](./04_memory.qmd)** — Two approaches to
  persistence: automatically recording everything to SQLite, or giving
  the LLM an explicit “remember” tool. An advanced recipe that shows the
  power of hooks.

- **[Context Compaction](./05_context_compaction.qmd)** — Automatically
  summarize and reset context when token usage gets high. Useful for
  long-running conversations that would otherwise hit context limits.

## Security and Isolation

- **[Custom Sandboxing](./06_custom_sandboxing.qmd)** — Isolate tool
  execution using wrapper scripts. Covers logging, Bubblewrap isolation,
  and stateful “shadow workspaces.” Essential reading if you’re giving
  LLMs write access to your system.

## Advanced Techniques

- **[Control Flow with Macros](./07_control_flow_macros.qmd)** —
  Implement loops, conditionals, and map operations using recursive
  macros. This is power-user territory—most workflows don’t need this,
  but it shows what’s possible.

- **[Agent Skills Support](./08_skills_subcommand.qmd)** — Build a
  subcommand that exposes the [Agent Skills](https://agentskills.io)
  format, letting your LLM load capabilities on demand through
  progressive disclosure.



# Reference: Command‑Line Interface

The `lectic` command is the primary way to interact with Lectic. It can
read from a file or from standard input, and it offers flags to control
how the result is printed or saved.

## Usage

``` bash
lectic [FLAGS] [OPTIONS] [SUBCOMMAND] [ARGS...]
```

## Subcommands

- `lectic lsp` Start the LSP server. Transport: stdio.

- `lectic parse` Parse a lectic file into a JSON representation of the
  parsed file structure. Useful for programmatic analysis and
  modification.

  Flags:

  - `--yaml`: Emit YAML instead of JSON.
  - `--reverse`: Ingest JSON (or YAML) output and reconstruct the
    original lectic file.

- `lectic models` List available models for providers with detected
  credentials.

  Providers with API keys in the environment are queried. The `chatgpt`
  provider is listed if you have previously logged in (it is not an API
  key-based provider).

- `lectic script` Bundle and run a JS/TS/JSX/TSX module using Lectic’s
  internal Bun runtime. Works as a hashbang interpreter, useful for
  writing subcommands (see below), [hooks](../automation/02_hooks.qmd),
  and [exec tools](../tools/02_exec.qmd).

  During bundling, Lectic supports explicit remote imports via
  `https://...` URLs (and `http://` for localhost only), in order to
  easily support writing self-contained single-file scripts.

  For TSX/JSX scripts using React’s automatic runtime, include an
  explicit `import React from "https://..."` so Lectic can resolve the
  implicit `react/jsx-runtime` / `react/jsx-dev-runtime` imports.

  Bundled output is cached on disk under `$LECTIC_CACHE/scripts/`. The
  cache key includes the script contents, the Bun version, and an
  internal plugin version. Delete that directory to force a re-bundle.

  Note: remote imports are treated as pinned by URL. Changes on the
  remote server will not invalidate the cache automatically.

  Prefer versioned URLs so builds are reproducible. For example, when
  using esm.sh, import `react@18.3.1` instead of `react`:

  `import React from "https://esm.sh/react@18.3.1"`

  For example:

  ``` bash
  #!/bin/env -S lectic script
  console.log("Hello from a lectic script!")
  ```

- `lectic a2a` Start an A2A (JSON-RPC + SSE) server exposing configured
  agents.

  Options:

  - `--root <path>`: Workspace root (process.chdir to this path).
  - `--host <host>`: Bind host. Default: `127.0.0.1`.
  - `--port <port>`: Bind port. Default: `41240`.
  - `--token <token>`: If set, require `Authorization: Bearer <token>`.
  - `--max-tasks-per-context <n>`: Maximum number of task snapshots to
    keep in memory per contextId. Default: `50`.

  Monitoring endpoints (HTTP):

  Cross-agent:

  - `GET /monitor/agents`
    - Lists configured agents.
  - `GET /monitor/tasks`
    - Returns recent task snapshots across all agents.
    - Optional query: `?agentId=<id>&contextId=<id>`.
  - `GET /monitor/tasks/<taskId>`
    - Returns a single task snapshot, searching across all agents.
  - `GET /monitor/events`
    - Server-Sent Events stream of task lifecycle events.
    - Optional query: `?agentId=<id>&contextId=<id>`.

  Per-agent:

  - `GET /monitor/agents/<id>/tasks`
    - Returns recent task snapshots.
    - Optional query: `?contextId=<id>`.
  - `GET /monitor/agents/<id>/tasks/<taskId>`
    - Returns a single task snapshot.
  - `GET /monitor/agents/<id>/events`
    - Server-Sent Events stream of task lifecycle events.
    - Optional query: `?contextId=<id>`.

  If `--token` is set, the monitoring endpoints require
  `Authorization: Bearer <token>`.

## Custom Subcommands

Lectic supports git-style custom subcommands. If you invoke
`lectic <command>`, Lectic will look for an executable named
`lectic-<command>` in your configuration directory, data directory, or
PATH.

See [Custom Subcommands](../automation/03_custom_subcommands.qmd) for a
full guide on creating subcommands and adding tab completion for them.

## Bash completion

The repository includes a bash completion script. See [Getting
Started](../02_getting_started.qmd#tab-completion-optional) for
installation instructions.

The completion system is extensible. You can write plugins to provide
completions for your custom subcommands. See the [Custom
Subcommands](../automation/03_custom_subcommands.qmd#tab-completion)
guide for details.

## Flags and options

- `-v`, `--version` Prints the version string.

- `-f`, `--file <PATH>` Path to the conversation file (`.lec`) to
  process. If omitted, Lectic reads from standard input.

- `-i`, `--inplace <PATH>` Read from the given file and update it in
  place. Mutually exclusive with `--file`.

- `-s`, `--short` Only emit the newly generated assistant message, not
  the full updated conversation.

- `-S`, `--Short` Like `--short`, but emits only the raw message text
  (without the `:::Speaker` wrapper).

- `-l`, `--log <PATH>` Write detailed debug logs to the given file.

- `-q`, `--quiet` Suppress printing the assistant’s response to stdout.

- `-h`, `--help` Show help for all flags and options.

## Constraints

- –inplace cannot be combined with –file.
- –quiet cannot be combined with –short or –Short.

## Common examples

- Generate the next message in a file and update it in place:

  ``` bash
  lectic -i conversation.lec
  ```

- Read from stdin and write the full result to stdout:

  ``` bash
  cat conversation.lec | lectic
  ```

- Stream just the new assistant message:

  ``` bash
  lectic -s -f conversation.lec
  ```

- Add a message from the command line and update the file:

  ``` bash
  echo "This is a new message." | lectic -i conversation.lec
  ```

- List available models for detected providers:

  ``` bash
  lectic models
  ```

- Start the LSP server (stdio transport):

  ``` bash
  lectic lsp
  ```

- Parse a file to JSON:

  ``` bash
  lectic parse -f conversation.lec
  ```

- Round-trip a file through parsing and reconstruction:

  ``` bash
  lectic parse -f conversation.lec | lectic parse --reverse
  ```



# Reference: Configuration Keys

This document provides a reference for all the keys available in
Lectic’s YAML configuration, including the main `.lec` file frontmatter
and any included configuration files.

## Top-Level Keys

- `interlocutor`: A single object defining the primary LLM speaker.
- `interlocutors`: A list of interlocutor objects for multiparty
  conversations.
- `kits`: A list of named tool kits you can reference from
  interlocutors.
- `macros`: A list of macro definitions. See
  [Macros](../automation/01_macros.qmd).
- `hooks`: A list of hook definitions. See
  [Hooks](../automation/02_hooks.qmd).
- `sandbox`: A default sandbox command string applied to all `exec`
  tools and local `mcp_command` tools, unless overridden by
  `interlocutor.sandbox` or a tool’s own `sandbox` setting.

------------------------------------------------------------------------

## The `kit` Object

A kit is a named list of tools that can be reused from an interlocutor’s
`tools` array using `- kit: <name>`.

- `name`: (Required) The kit name.
- `tools`: (Required) An array of tool definitions.
- `description`: (Optional) Short documentation shown in editor hovers
  and autocomplete.

------------------------------------------------------------------------

## The `interlocutor` Object

An interlocutor object defines a single LLM “personality” or
configuration.

- `name`: (Required) The name of the speaker, used in the `:::Name`
  response blocks.
- `prompt`: (Required) The base system prompt that defines the LLM’s
  personality and instructions. The value can be a string, or it can be
  loaded from a file (`file:./path.txt`) or a command
  (`exec:get-prompt`). See [External
  Prompts](../context_management/03_external_prompts.qmd) for details
  and examples.
- `hooks`: A list of hook definitions. See
  [Hooks](../automation/02_hooks.qmd). These hooks fire only when this
  interlocutor is active.
- `sandbox`: A command string (e.g. `/path/to/script.sh` or
  `wrapper.sh arg1`) to wrap execution for all `exec` tools and local
  `mcp_command` tools used by this interlocutor, unless overridden by
  the tool’s own `sandbox` setting. This overrides any top-level
  `sandbox` setting.

### Model Configuration

- `provider`: The LLM provider to use. Supported values include
  `anthropic`, `anthropic/bedrock`, `openai` (Responses API),
  `openai/chat` (legacy Chat Completions), `gemini`, `ollama`, and
  `openrouter`.
- `model`: The specific model to use, e.g., `claude-3-opus-20240229`.
- `temperature`: A number between 0 and 1 controlling the randomness of
  the output.
- `max_tokens`: The maximum number of tokens to generate in a response.
- `max_tool_use`: The maximum number of tool calls the LLM is allowed to
  make in a single turn.
- `thinking_effort`: Optional hint (used by the `openai` Responses
  provider, and by `gemini-3-pro`) about how much effort to spend
  reasoning. One of `none`, `low`, `medium`, or `high`.
- `thinking_budget`: Optional integer token budget for providers that
  support structured thinking phases (Anthropic, Anthropic/Bedrock,
  Gemini). Ignored by the `openai` and `openai/chat` providers.

#### Providers and defaults

If you don’t specify `provider`, Lectic picks a default based on your
environment. It checks for known API keys in this order and uses the
first one it finds:

1.  ANTHROPIC_API_KEY
2.  GEMINI_API_KEY
3.  OPENAI_API_KEY
4.  OPENROUTER_API_KEY

AWS credentials for Bedrock are not considered for auto‑selection. If
you want Anthropic via Bedrock, set `provider: anthropic/bedrock`
explicitly and ensure your AWS environment is configured.

OpenAI has two provider options:

- `openai` uses the Responses API. You’ll want this for native tools
  like search and code.
- `openai/chat` uses the legacy Chat Completions API. You’ll need this
  for certain audio workflows that still require chat‑style models.

For a more detailed discussion of provider and model options, see
[Providers and Models](../06_providers_and_models.qmd).

### Tools

- `tools`: A list of tool definitions that this interlocutor can use.
  The format of each object in the list depends on the tool type. See
  the [Tools section](../tools/01_overview.qmd) for detailed
  configuration guides. All tools support a `hooks` array for
  `tool_use_pre` hooks scoped to that particular tool.

#### Common tool keys

These keys are shared across multiple tool types:

- `name`: A custom name for the tool. If omitted, a default is derived
  from the tool type.
- `usage`: Instructions for the LLM on when and how to use the tool.
  Accepts a string, `file:`, or `exec:` source.
- `hooks`: A list of hooks scoped to this tool (typically
  `tool_use_pre`).

#### `exec` tool keys

Run commands and scripts.

- `exec`: (Required) The command or inline script to execute. Multi-line
  values must start with a shebang.
- `schema`: A map of parameter name → description. When present, the
  tool takes named string parameters (exposed as env vars). When absent,
  the tool takes a required `arguments` array of strings.
- `sandbox`: Command string to wrap execution. Arguments supported.
- `timeoutSeconds`: Seconds to wait before aborting.
- `env`: Environment variables to set for the subprocess.

#### `sqlite` tool keys

Query SQLite databases.

- `sqlite`: (Required) Path to the SQLite database file.
- `readonly`: Boolean. If `true`, opens the database in read-only mode.
- `limit`: Maximum size of serialized response in bytes.
- `details`: Extra context for the model. Accepts string, `file:`, or
  `exec:`.
- `extensions`: A list of SQLite extension libraries to load.

#### `agent` tool keys

Call another interlocutor as a tool.

- `agent`: (Required) The name of the interlocutor to call.
- `raw_output`: Boolean. If `true`, includes raw tool call results in
  the output rather than sanitized text.

#### MCP tool keys

Connect to Model Context Protocol servers.

- One of: `mcp_command`, `mcp_ws`, or `mcp_shttp`.
- `args`: Arguments for `mcp_command`.
- `env`: Environment variables for `mcp_command`.
- `headers`: A map of custom headers for `mcp_shttp`. Values support
  `file:` and `exec:`.
- `sandbox`: Optional wrapper command to isolate `mcp_command` servers.
- `roots`: Optional list of root objects for file access (each with
  `uri` and optional `name`).
- `exclude`: Optional list of server tool names to blacklist.
- `only`: Optional list of server tool names to whitelist.

#### Other tool keys

- `think_about`: (String) Creates a thinking/scratchpad tool with the
  given prompt.
- `serve_on_port`: (Integer) Creates a single-use web server on the
  given port.
- `native`: One of `search` or `code`. Enables provider built-in tools.
- `kit`: Name of a tool kit to include.

If you add keys to an interlocutor object that are not listed in this
section, Lectic will still parse the YAML, but the LSP marks those
properties as unknown with a warning. This is usually a sign of a typo
in a key name.

------------------------------------------------------------------------

## The `macro` Object

- `name`: (Required) The name of the macro, used when invoking it with
  `:name[]` or `:name[args]`.
- `expansion`: (Optional) The content to be expanded. Can be a string,
  or loaded via `file:` or `exec:`. Equivalent to `post` if provided.
  See [External Prompts](../context_management/03_external_prompts.qmd)
  for details about `file:` and `exec:`.
- `pre`: (Optional) Expansion content for the pre-order phase.
- `post`: (Optional) Expansion content for the post-order phase.
- `env`: (Optional) A dictionary of environment variables to be set
  during the macro’s execution. These are merged with any arguments
  provided at the call site.

------------------------------------------------------------------------

## The `hook` Object

- `on`: (Required) A single event name or a list of event names to
  trigger the hook. Supported events are `user_message`,
  `assistant_message`, `error`, and `tool_use_pre`.
- `do`: (Required) The command or inline script to run when the event
  occurs. If multi‑line, it must start with a shebang (e.g.,
  `#!/bin/bash`). Event context is provided as environment variables.
  See the Hooks guide for details.
- `inline`: (Optional) Boolean. If `true`, the output of the hook is
  captured and injected into the conversation. Defaults to `false`.
- `name`: (Optional) A name for the hook. Used for merging and
  overriding hooks from different configuration sources.
- `env`: (Optional) A dictionary of environment variables to be set when
  the hook runs.

# LSP Server Reference


# LSP Server

Lectic includes a Language Server Protocol (LSP) server that makes
editing `.lec` files more pleasant. It provides completions,
diagnostics, folding, and other features that help you write correct
configurations and navigate conversations.

Start the server with:

``` bash
lectic lsp
```

The server uses stdio transport and works with any LSP-capable editor.
See [Editor Integration](../03_editor_integration.qmd) for setup
instructions.

## Features

### Completions

The LSP suggests completions as you type:

- **Directives**: Type `:` to see built-in directives (`:cmd`, `:env`,
  `:fetch`, `:verbatim`, `:once`, `:discard`, `:attach`, `:ask`,
  `:aside`, `:reset`) and any macros you’ve defined.
- **Interlocutor names**: Inside `:ask[` or `:aside[`, the LSP suggests
  names from your configuration.
- **YAML header fields**: In the frontmatter, get suggestions for
  interlocutor properties (`provider`, `model`, `thinking_effort`,
  etc.), tool types, kit names, and model names.
- **Tool types**: Type `-` inside a `tools:` array to see available tool
  kinds (`exec`, `sqlite`, `mcp_command`, `native`, etc.).

Completions are case-insensitive and respect any prefix you’ve typed.

### Diagnostics

The server catches errors before you run the file:

- **YAML syntax errors**: Malformed frontmatter is flagged immediately.
- **Missing required fields**: An interlocutor without a `name` or
  `prompt` triggers an error.
- **Unknown properties**: A typo like `promt` instead of `prompt` shows
  a warning.
- **Duplicate names**: If you define two interlocutors or macros with
  the same name, the LSP warns you. (The later definition wins at
  runtime.)

### Folding

Tool calls and inline attachments can be long. The LSP provides folding
ranges so your editor can collapse them:

``` markdown
:::Assistant

<tool-call with="search">        ← Fold starts here
...                              ← Hidden when folded
</tool-call>                     ← Fold ends here

Based on the search results...
:::
```

Both Neovim and VS Code plugins enable folding by default.

### Hover Information

Hover over elements to see documentation:

- **Directives**: Hover on built-in directives to see what they do.
- **Macros**: Hover on a macro directive to preview its expansion.
- **Tool calls**: Hover on a `<tool-call>` block to see a summary.

### Go to Definition

Jump to where things are defined:

- Place your cursor on a macro name and invoke “Go to Definition” to
  jump to the macro’s definition in your config.
- Works for interlocutors, kits, and macros.
- If multiple definitions exist (e.g., a local override of a system
  config), the LSP returns all locations, prioritized by proximity.

### Document Outline

The LSP provides document symbols showing the conversation structure:
messages, interlocutor responses, and configuration sections. Use your
editor’s outline view to navigate long conversations.

## Editor Setup

### Neovim

Auto-start the LSP for `.lec` files:

``` lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "lectic", "markdown.lectic", "lectic.markdown" },
  callback = function(args)
    vim.lsp.start({
      name = "lectic",
      cmd = { "lectic", "lsp" },
      root_dir = vim.fs.root(args.buf, { ".git", "lectic.yaml" })
                 or vim.fn.getcwd(),
      single_file_support = true,
    })
  end,
})
```

For LSP-based folding:

``` lua
vim.opt.foldmethod = 'expr'
vim.opt.foldexpr = 'v:lua.vim.lsp.foldexpr()'
```

With nvim-cmp, completions appear automatically on `:` and `-`. For
bracket completions (interlocutor names), you may need to invoke
completion manually with `<C-Space>` or `<C-x><C-o>`.

### VS Code

Install the extension from `extra/lectic.vscode` or download the VSIX
from [releases](https://github.com/gleachkr/Lectic/releases). The
extension starts the LSP automatically for `.lec` files.

### Other Editors

Any editor that supports LSP over stdio can use the Lectic server. The
command is `lectic lsp` with no arguments. See your editor’s
documentation for how to configure external language servers.

## Technical Details

### Completion Sources

Completions are merged from multiple configuration sources, with later
sources taking precedence:

1.  System config: `$LECTIC_CONFIG/lectic.yaml`
2.  Workspace config: `lectic.yaml` in the document’s directory
3.  The document’s YAML header

This matches the precedence used at runtime, so what you see in
completions reflects what will actually be available.

### Triggers

- `:` triggers directive and macro completions
- `[` after `:ask` or `:aside` triggers interlocutor name completions
- `-` in a `tools:` array triggers tool type completions

### Limitations

- Completion previews are static. The server doesn’t expand `exec:` or
  read `file:` references when showing previews.
- No completions are offered inside `:::` fences (those are response
  blocks, not meant for editing).



# Tools Overview

Tools let your LLM do things. Instead of stopping at text, it can run a
command, query a database, call another agent, or reach out to a
service.

## Quick Reference

| Tool | Purpose | Minimal Config |
|----|----|----|
| [`exec`](./02_exec.qmd) | Run commands and scripts | `exec: date` |
| [`sqlite`](./03_sqlite.qmd) | Query SQLite databases | `sqlite: ./data.db` |
| [`mcp`](./04_mcp.qmd) | Connect to MCP servers | `mcp_command: npx ...` |
| [`agent`](./05_agent.qmd) | Call another interlocutor | `agent: OtherName` |
| [`a2a`](./07_a2a.qmd) | Call a remote A2A agent | `a2a: http://.../agents/<id>` |
| [`think`](./06_other_tools.qmd#the-think-tool) | Private reasoning scratchpad | `think_about: the problem` |
| [`serve`](./06_other_tools.qmd#the-serve-tool) | Serve HTML to browser | `serve_on_port: 8080` |
| [`native`](./06_other_tools.qmd#native-tools) | Provider built-ins (search, code) | `native: search` |

## How Tool Calls Work

In Lectic, you configure tools for each interlocutor in the YAML
frontmatter. A tool call follows a four-step process:

1.  **User Prompt**: You ask something that requires a tool.
2.  **LLM Tool Call**: The LLM outputs a block indicating which tool to
    use.
3.  **Lectic Executes**: Lectic runs the tool and captures output.
4.  **LLM Response**: The tool output goes back to the LLM, which
    answers.

## Tool Call Syntax

Lectic uses XML blocks for tool calls:

``` xml
<tool-call with="tool_name">
<arguments>
  <!-- one element per parameter -->
</arguments>
<results>
  <!-- filled by Lectic after execution -->
</results>
</tool-call>
```

You’ll see these in assistant blocks. Lectic writes the block when the
model requests a tool, then appends results after running it.

### Example

Configuration:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  tools:
    - exec: date
      name: get_date
---

What's the date today?
```

Result:

``` markdown
:::Assistant

<tool-call with="get_date">
<arguments><argv>[ ]</argv></arguments>
<results>
<result type="text">
┆<stdout>Fri Mar 15 14:35:18 PDT 2024</stdout>
</result>
</results>
</tool-call>

Today is March 15th, 2024.

:::
```

## Parallel Execution

When an LLM uses multiple tools in one turn, Lectic runs them
concurrently. This speeds up tasks that gather information from several
sources.

## Tool Kits

Reuse tool sets across interlocutors by defining named kits.

Kits can also include an optional `description`, which is shown in
editor hovers and autocomplete.

``` yaml
kits:
  - name: typescript_tools
    description: TypeScript checks (tsc + eslint)
    tools:
      - exec: tsc --noEmit
        name: typecheck
      - exec: eslint
        name: lint

interlocutor:
  name: Assistant
  prompt: You help with TypeScript.
  tools:
    - kit: typescript_tools
    - exec: cat
      name: read_file
```

## Hooks

The `tool_use_pre` hook fires after parameters are collected but before
execution. If the hook exits non-zero, the call is blocked:

``` yaml
interlocutor:
  tools:
    - exec: rm
      name: delete
      hooks:
        - on: tool_use_pre
          do: ~/.config/lectic/confirm.sh
```

See [Hooks](../automation/02_hooks.qmd) for details.

## Tool Guides

Each tool type has its own detailed guide:

- **[Exec](./02_exec.qmd)**: Shell commands and scripts. The most
  versatile tool — anything you can run from the command line, your LLM
  can run too.

- **[SQLite](./03_sqlite.qmd)**: Direct database queries. Schema is
  auto-introspected and provided to the LLM.

- **[MCP](./04_mcp.qmd)**: Model Context Protocol servers. Connect to a
  growing ecosystem of pre-built tools and services.

- **[Agent](./05_agent.qmd)**: Multi-LLM workflows. One interlocutor can
  delegate to another, enabling specialized agents.

- **[A2A](./07_a2a.qmd)**: Talk to remote agents using the Agent2Agent
  (A2A) protocol.

- **[Other Tools](./06_other_tools.qmd)**: The `think` tool for
  reasoning, `serve` for rendering HTML, and `native` for provider
  built-ins like web search.

> [!NOTE]
>
> Native tools (`native: search`, `native: code`) do not support hooks.



# Tools: Command Execution (`exec`)

The `exec` tool is one of the most versatile tools in Lectic. It allows
the LLM to execute commands and scripts, enabling it to interact
directly with your system, run code, and interface with other
command‑line applications.

## Configuration

The snippets below show only the tool definition. They assume you have
an interlocutor with a valid prompt and model configuration. See Getting
Started for a full header example.

You configure an `exec` tool by providing the command to be executed.
You can also provide a custom `name` for the LLM to use, a `usage`
guide, and optional parameters for security and execution control.

### Simple command

This configuration allows the LLM to run the `python3` interpreter.

``` yaml
tools:
  - exec: python3
    name: python
    usage: >
      Use this to execute Python code. The code to be executed should be
      written inside the tool call block.
```

### Inline script

You can also provide a multi‑line script in the YAML. The first line of
the script must be a shebang (for example, `#!/usr/bin/env bash`) to
choose the interpreter.

``` yaml
tools:
  - name: line_counter
    usage: "Counts the number of lines in a file. Takes one argument: path."
    exec: |
      #!/usr/bin/env bash
      # A simple script to count the lines in a file
      wc -l "$1"
```

### Configuration parameters

- `exec`: (Required) The command or inline script to execute.
- `name`: An optional name for the tool.
- `usage`: A string with instructions for the LLM. It also accepts
  `file:` and `exec:` sources. See [External
  Prompts](../context_management/03_external_prompts.qmd) for semantics.
- `sandbox`: A command string to wrap execution
  (e.g. `/path/to/script.sh` or `wrapper.sh arg1`). See safety below.
  Overrides any interlocutor-level or top-level sandbox.
- `timeoutSeconds`: Seconds to wait before aborting a long‑running call.
- `env`: Environment variables to set for the subprocess.
- `schema`: A map of parameter name → description. When present, the
  tool takes named string parameters (exposed as env vars). When absent,
  the tool instead takes a required `arguments` array of strings.

## Execution details

- No shell is involved when executing single line commands. The command
  is executed directly. Shell features like globbing or command
  substitution will not work unless you invoke a shell yourself.
- Single‑line `exec` values have environment variables expanded before
  execution using the tool’s `env` plus standard Lectic variables.
- Single‑line commands are split into argv using simple shell‑like
  rules: single ‘…’ and double “…” quotes are supported; no globbing or
  substitution. If you need shell features, invoke a shell explicitly,
  e.g., `bash -lc '...'`.
- Multi‑line `exec` values must start with a shebang. Lectic writes the
  script to a temporary file and executes it with that interpreter.

### Working directory and files

The current working directory for `exec` is:

- If you run with `-f` or `-i`: the directory containing the `.lec`
  file.
- Otherwise: the directory from which you invoked the `lectic` command.

This means relative paths in your commands and scripts resolve relative
to that directory. Temporary scripts are written into the same working
directory.

### Stdout, stderr, and exit codes

Lectic captures stdout and stderr separately and returns both to the
model. It also includes the numeric exit code when it is non‑zero. You
will see these serialized inside the tool call results as XML tags like
, , and .

If a timeout occurs, Lectic kills the subprocess and throws an error
that includes any partial stdout and stderr collected so far.

### Named parameters with `schema`

You might want to control what arguments your LLM can pass to a command
or script, or offer a template for correct usage. If your configuration
includes a `schema`, the LLM will be guided to provide specific
parameters when calling the script or command. Each parameter is a
string and Lectic exposes it to the subprocess via an environment
variable with the same name.

This applies to both commands and scripts:

- For scripts, parameters are available as `$PARAM_NAME` inside the
  script.
- For commands, parameters are available in the subprocess environment
  and also expanded in the command.

Example:

``` yaml
# YAML configuration
tools:
  - name: greeter
    exec: |
      #!/usr/bin/env bash
      echo "Hello, ${NAME}! Today is ${DAY}."
    schema:
      NAME: The name to greet.
      DAY: The day string to include.
```

or equivalently

``` yaml
# YAML configuration
tools:
  - name: greeter
    exec: echo "Hello, ${NAME}! Today is ${DAY}."
    schema:
      NAME: The name to greet.
      DAY: The day string to include.
```

If the LLM provides `{ NAME: "Ada", DAY: "Friday" }` Lectic will fill in
the results:

    <tool-call with="greeter">
    <arguments>
    <NAME>
    ┆Ada
    </NAME>
    <DAY>
    ┆Friday
    </DAY>
    </arguments>
    <results>
    <result type="text">
    ┆Hello, Ada! Today is Friday.
    ┆
    </result>
    </results>
    </tool-call>

## Execution environment

When Lectic runs your command or script, it sets a few helpful
environment variables. In particular, `LECTIC_INTERLOCUTOR` is set to
the name of the interlocutor who invoked the tool. This makes it easy to
maintain per‑interlocutor state (for example, separate scratch
directories or memory stores) in your scripts or sandbox wrappers.

## Safety and trust

> [!WARNING]
>
> Granting an LLM the ability to execute commands can be dangerous.
> Treat every `exec` tool as a capability you are delegating. Combine
> human‑in‑the‑ loop confirmation and sandboxing to minimize risk. Do
> not expose sensitive files or networks unless you fully trust the tool
> and its usage.

Lectic provides two mechanisms to help you keep `exec` tools safe: hooks
and sandboxing.

### Confirmation via hooks

You can use the `tool_use_pre` hook to implement confirmation dialogs or
logic. See [Hooks](../automation/02_hooks.qmd) for examples.

### Sandboxing (`sandbox`)

When a `sandbox` is configured, a tool call will actually execute the
`sandbox` command, which will receive the original command and the LLM
provided parameters as arguments. The wrapper is responsible for
creating a controlled environment to run the command.

You can include arguments in the sandbox string (e.g. `bwrap.sh --net`).

See the [Custom Sandboxing](../cookbook/06_custom_sandboxing.qmd)
cookbook recipe for a detailed guide on writing your own sandbox
scripts.

For example, `extra/sandbox/bwrap-sandbox.sh` uses Bubblewrap to create
a minimal, isolated environment with a temporary home directory.

You can also set a default sandbox at the top level (`sandbox`) or on
the `interlocutor` object. If set, it applies to all `exec` tools that
don’t specify their own. Tool-level `sandbox` wins over both defaults.



# Tools: SQLite Query

The `sqlite` tool gives your LLM the ability to query SQLite databases
directly. This is a powerful way to provide access to structured data,
allowing the LLM to perform data analysis, answer questions from a
knowledge base, or check the state of an application.

> [!NOTE]
>
> ### Why not just use `exec: sqlite3`?
>
> You could give the LLM a shell command like `exec: sqlite3 ./data.db`,
> but the built-in `sqlite` tool does more:
>
> - **Schema introspection**: Lectic reads the database schema and
>   includes it in the tool description, so the LLM knows what tables
>   and columns exist without you having to explain them.
> - **Result limiting**: Large query results can overwhelm the context
>   window. The `limit` parameter caps response size and returns an
>   error if exceeded, prompting the LLM to write a more selective
>   query.
> - **YAML output**: Results are formatted as YAML, which LLMs tend to
>   parse more reliably than raw SQL output.
> - **Atomic transactions**: Each tool call runs in a transaction. If
>   anything fails, changes are rolled back.
> - **No external binary**: Lectic uses Bun’s built-in SQLite support,
>   so you don’t need `sqlite3` installed.

## Configuration

The snippets below show only the tool definition. They assume you have
an interlocutor with a valid prompt and model configuration. See Getting
Started for a full header example.

To configure the tool, you must provide the path to the SQLite database
file. The database schema is automatically introspected and provided to
the LLM, so it knows what tables and columns are available.

``` yaml
tools:
  - sqlite: ./products.db
    name: db_query
    limit: 10000
    readonly: true
    details: >
      Contains the full product catalog and inventory levels. Use this to
      answer questions about what is in stock.
    extensions:
      - ./lib/vector0
      - ./lib/math
```

The path can include environment variables (for example,
`$DATA_DIR/main.db`), which Lectic expands.

### Configuration parameters

- `sqlite`: (Required) Path to the SQLite database file.
- `name`: A custom tool name.
- `readonly`: To set the database as read only.
- `limit`: Maximum size of the serialized response in bytes. Large
  results raise an error instead of flooding the model.
- `details`: Extra high‑level context for the model. String, `file:`, or
  `exec:` are accepted. See [External
  Prompts](../context_management/03_external_prompts.qmd).
- `extensions`: A list of SQLite extension libraries to load before
  queries.

### Example conversation

Configuration:

``` yaml
tools:
  - sqlite: ./chinook.db
    name: chinook
```

Conversation:

``` markdown
Who are the top 5 artists by number of tracks?

:::Assistant

I will query the database to find out.

<tool-call with="chinook">
<arguments>
<query>
┆SELECT
┆ar.Name,
┆COUNT(t.TrackId) AS TrackCount
┆FROM Artists ar
┆JOIN Albums al ON ar.ArtistId = al.ArtistId
┆JOIN Tracks t ON al.AlbumId = t.AlbumId
┆GROUP BY ar.Name
┆ORDER BY TrackCount DESC
┆LIMIT 5;
</query>
</arguments>
<results>
<result type="text">
┆- Name: Iron Maiden
┆TrackCount: 213
┆- Name: Led Zeppelin
┆TrackCount: 114
┆- Name: Metallica
┆TrackCount: 112
┆- Name: U2
┆TrackCount: 110
┆- Name: Deep Purple
┆TrackCount: 92
</result>
</results>
</tool-call>

Based on the data, the top artists by track count are Iron Maiden, Led
Zeppelin, Metallica, U2, and Deep Purple.

:::
```

## Writes and transactions

Writes are allowed by default. Each tool call runs inside a transaction
and is atomic. If any statement in the call fails, Lectic rolls back the
entire call, so the database is unchanged.

## Limits and large results

The `limit` parameter caps the size of the serialized YAML that Lectic
returns. If a result exceeds the cap, the tool raises an error. Tighten
your query (for example, add `LIMIT` or select fewer columns) to stay
under the cap.

## Extensions

You can load extensions by path before queries run. On macOS, note that
the system SQLite build may restrict loading extensions. Consult the Bun
SQLite extension documentation if you hit issues.



# Tools: Model Context Protocol (`mcp`)

Lectic can act as a client for servers that implement the [Model Context
Protocol (MCP)](https://modelcontextprotocol.io). This allows you to
connect your LLM to a vast and growing ecosystem of pre-built tools and
services.

## What is MCP?

MCP is a standard protocol for connecting LLMs to external tools and
data sources. Instead of writing custom integrations for every service,
you can use any MCP-compatible server. Servers exist for GitHub,
databases, file systems, web browsers, and much more.

The protocol handles the details of how tools describe themselves and
how results are returned. Lectic speaks MCP, so you can drop in any
compatible server and the LLM can use its tools immediately.

You can find lists of available servers here:

- [Official MCP Server
  List](https://github.com/modelcontextprotocol/servers)
- [Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers)

## Configuration

Note: The snippets below show only the tool definition. They assume you
have an interlocutor with a valid prompt and model configuration. See
Getting Started for a full header example.

You can connect to an MCP server in three ways: by running a local
server as a command, or by connecting to a remote server over WebSockets
or SSE.

### Local MCP Server (`mcp_command`)

This is the most common way to run an MCP server. You provide the
command to start the server, and Lectic manages its lifecycle.

``` yaml
tools:
  - name: brave
    mcp_command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-brave-search"
    env:
      BRAVE_API_KEY: "your_key_here"
    roots:
      - /home/user/research-docs/
```

Local MCP servers are started on demand for the active interlocutor and
managed by Lectic for the duration of the session.

### Remote MCP Servers

You can also connect to running MCP servers.

- `mcp_ws`: The URL for a remote server using a WebSocket connection.
- `mcp_shttp`: The URL for a remote server using Streamable HTTP.

For example:

``` yaml
tools:
  - name: documentation_search 
    mcp_shttp: https://mcp.context7.com/mcp
```

#### Authentication for Streamable HTTP

The `mcp_shttp` transport supports both custom headers and dynamic OAuth
2.0.

Custom headers can be provided using the `headers` key. Header values
support `file:` and `exec:` sources, which is useful for securely
loading tokens or computing authentication headers on the fly.

``` yaml
tools:
  - name: github_mcp
    mcp_shttp: https://api.githubcopilot.com/mcp
    headers:
      Authorization: exec:bash -c 'echo "Bearer $(pass github_token)"'
```

If a server requires OAuth 2.0 and supports the MCP OAuth flow, Lectic
will automatically handle the authorization process. When an
unauthorized request is made, Lectic will open your default browser to
complete the login, and then securely persist the resulting tokens in
your data directory.

### Server Resources and Content References

If you give an MCP tool a `name` (e.g., `name: brave`), you can access
any [resources](https://modelcontextprotocol.io/docs/concepts/resources)
it provides using a special content reference syntax. The scheme is the
server’s name plus the resource type.

For example, to access a `repo` resource from a server named `github`:
`[README](github+repo://gleachkr/Lectic/contents/README.md)`

The LLM is also given a tool to list the available resources from the
server.

### Blacklisting and whitelisting server tools

You can hide specific tools that a server exposes by listing their names
under `exclude`.

``` yaml
tools:
  - name: github
    mcp_ws: wss://example.org/mcp
    exclude:
      - dangerous_tool
      - low_value_tool
```

You can also limit access to a specific set of tools that a server
exposes by listing their names under `only`.

``` yaml
tools:
  - name: github
    mcp_ws: wss://example.org/mcp
    only:
      - safe_tool
      - high_value_tool
```

If you specify both options at once, you’ll get exactly the tools from
the `only` list that aren’t also excluded.

## Safety and trust

> [!WARNING]
>
> While powerful, the MCP protocol carries significant security risks.
> Treat MCP integration as a high-trust capability. Never connect to
> untrusted servers; a malicious server could exfiltrate data or perform
> unwanted actions. Lectic’s safety mechanisms reduce mistakes from a
> well‑behaved LLM, not attacks from a hostile server.

### Confirmation via hooks

Just like with the `exec` tool, you can use the `tool_use_pre` hook to
implement confirmation dialogs or logic. See
[Hooks](../automation/02_hooks.qmd) for examples.

### Sandboxing (`sandbox`)

For local `mcp_command` tools, you can specify a `sandbox` command. This
command will be used to launch the MCP server process in a controlled
and isolated environment, limiting its access to your system. Arguments
are supported (e.g. `sandbox: wrapper.sh --strict`).

See the documentation for the [Exec Tool](./02_exec.qmd) for more
details on how sandboxing scripts work, and the [Custom
Sandboxing](../cookbook/06_custom_sandboxing.qmd) recipe for examples.

You can also set a default sandbox at the top level (`sandbox`) or on
the `interlocutor` object. If set, it applies to all local `mcp_command`
tools that don’t specify their own. Tool-level `sandbox` wins over both
defaults.



# Tools: Agent

The `agent` tool allows you to create sophisticated multi-LLM workflows
by enabling one interlocutor to call another as a tool. The “agent”
interlocutor receives the query from the “caller” with no other context,
processes it, and returns its response as the tool’s output.

This is a powerful way to separate concerns. You can create specialized
agents and then compose them into more complex systems. For an excellent
overview of the philosophy behind this approach, see Anthropic’s blog
post on their [multi-agent research
system](https://www.anthropic.com/engineering/built-multi-agent-research-system).

## Configuration

To use the `agent` tool, you must have at least two interlocutors
defined. In the configuration for one interlocutor, you add an `agent`
tool that points to the `name` of the other.

- `agent`: (Required) The name of the interlocutor to be called as an
  agent.
- `name`: An optional name for the tool.
- `usage`: A string, `file:`, or `exec:` URI providing instructions for
  the calling LLM on when and how to use this agent.
- `raw_output`: A boolean value. Normally an agent’s output will be
  sanitized, so that raw tool call results are not visible to the
  interlocutor who called the agent. Setting raw_output to true puts the
  full output from the agent into the main interlocutor’s tool call
  results.

### Example Configuration

In this setup, `Kirk` is the main interlocutor. He has a tool named
`communicator` which, when used, will call the `Spock` interlocutor.
`Spock` has his own set of tools, including a `think_about` tool to
encourage careful reasoning.

``` yaml
interlocutors:
  - name: Kirk
    prompt: You are Captain Kirk. You are bold and decisive.
    tools:
      - agent: Spock
        name: communicator
        usage: Use this to contact Spock for logical analysis and advice.

  - name: Spock
    prompt: >
      You are Mr. Spock. You respond with pure logic, suppressing all
      emotion.
    tools:
      - think_about: how to logically solve the problem presented.
```

## Example Conversation

Using the configuration above, Captain Kirk can delegate complex
analysis to Spock.

``` markdown
We've encountered an alien vessel of unknown origin. It is not responding to
hails. What is the logical course of action?

:::Kirk

This situation requires careful analysis. I will consult my science officer.

<tool-call with="communicator">
<arguments>
<content>
┆Alien vessel, unknown origin, unresponsive. Propose logical course of action.
</content>
</arguments>
<results>
<result type="text">
┆Insufficient data. Recommend passive scans to gather
┆information on their technological capabilities before initiating
┆further contact. Avoid any action that could be perceived as
┆hostile.
</result>
</results>
</tool-call>

A logical approach. We will proceed with passive scans.

:::
```

## Recursion

Agents can call other agents, and those agents can call back. There’s no
built-in limit on recursion depth, so be thoughtful about your
configurations. An agent that calls itself (or creates a cycle) will
keep going until it decides to stop or hits a token limit.

For example, Spock could have a tool that calls Kirk:

``` yaml
interlocutors:
  - name: Kirk
    prompt: You are Captain Kirk.
    tools:
      - agent: Spock
        name: consult_spock

  - name: Spock
    prompt: You are Mr. Spock.
    tools:
      - agent: Kirk
        name: consult_captain
```

This is powerful for workflows where agents need to collaborate, but it
requires clear instructions in the prompts about when to delegate and
when to answer directly.



# Other Tools: `think`, `serve`, and `native`

This document covers three distinct types of tools: a cognitive tool for
the LLM, a simple web server, and a way to access the native, built-in
capabilities of the model provider.

## The `think` Tool

The `think` tool gives the LLM a private “scratch space” to pause and
reason about a prompt before formulating its final response. This can
improve the quality and thoughtfulness of the output, especially for
complex or ambiguous questions.

This technique was inspired by a post on [Anthropic’s engineering
blog](https://www.anthropic.com/engineering/claude-think-tool). The
output of the `think` tool is hidden from the user by default in the
editor plugins, though it is still present in the `.lec` file.

### Configuration

``` yaml
tools:
  - think_about: >
      What the user is really asking for, and what hidden assumptions they
      might have.
    name: scratchpad # Optional name
```

### Example

``` markdown
What's the best city in the world?

:::Assistant

<tool-call with="scratchpad">
<arguments>
<thought>
┆"Best" is subjective. The user could mean best for travel, for
┆food, for work, etc. I need to ask for clarification.
</thought>
</arguments>
<results>
<result type="text">
┆thought complete.
</result>
</results>
</tool-call>

That depends on what you're looking for! Are you interested in the best city
for tourism, career opportunities, or something else?
:::
```

## The `serve` Tool

The `serve` tool lets the LLM show you interactive content—HTML pages,
visualizations, small web apps—directly in your browser. This is
Lectic’s answer to “artifacts” features you might have seen in web-based
LLM interfaces.

Why use this instead of just writing HTML to a file? With `serve`, the
content appears in your browser immediately. You don’t need to find the
file and open it. The LLM can generate a data visualization, a diagram,
or a playable game and you see it right away.

When the LLM uses this tool, Lectic starts a server on the specified
port and opens the page in your default browser. The server shuts down
automatically after the first request is served, and the conversation
resumes once your browser has loaded the page.

### Configuration

``` yaml
tools:
  - serve_on_port: 8080
    name: web_server # Optional name
```

### Example

``` markdown
Generate a simple tic-tac-toe game in HTML and serve it to me.

:::Assistant

<tool-call with="web_server">
<arguments>
<pageHtml>
┆<!DOCTYPE html>
┆<html>
┆<head>
┆<title>Tic-Tac-Toe</title>
┆... (rest of the HTML/JS/CSS) ...
┆</head>
┆<body>
┆...
┆</body>
┆</html>
</pageHtml>
</arguments>
<results>
<result type="text">
┆page is now available
</result>
</results>
</tool-call>


I have generated the game for you. It should be opening in your browser at
http://localhost:8080.
:::
```

## `native` Tools

Native tools allow you to access functionality that is built directly
into the LLM provider’s backend, such as web search or a code
interpreter environment for data analysis.

Support for native tools varies by provider.

### Configuration

You enable native tools by specifying their type.

``` yaml
tools:
  - native: search # Enable the provider's built-in web search.
  - native: code   # Enable the provider's built-in code interpreter.
```

### Provider Support

- **Gemini**: Supports both `search` and `code`. Note that the Gemini
  API has a limitation where you can only use one native tool at a time,
  and it cannot be combined with other (non-native) tools.
- **Anthropic**: Supports `search` only.
- **OpenAI**: Supports both `search` and `code` via the `openai`
  provider (not the legacy `openai/chat` provider).
- **ChatGPT**: Supports both `search` and `code` via the `chatgpt`
  provider (ChatGPT subscription, Codex backend).



# Tools: Agent2Agent (A2A)

The `a2a` tool lets your Lectic interlocutor call a remote agent that
implements the Agent2Agent (A2A) protocol.

This is useful for:

- Testing the built-in `lectic a2a` server
- Delegating work to an external agent process

## Configuration

You configure an A2A tool by providing the base URL for the agent.

If your agent card is served at:

- `http://HOST:PORT/agents/<id>/.well-known/agent-card.json`

then set the tool URL to:

- `http://HOST:PORT/agents/<id>`

Example:

``` yaml
tools:
  - name: remote_agent
    a2a: http://127.0.0.1:41240/agents/assistant
```

Optional settings:

- `stream`: prefer streaming (`message/sendStream`). Defaults to `true`.
- `maxWaitSeconds`: when streaming, max seconds to wait for the call to
  reach a final event before returning early with `taskId` so you can
  poll using `getTask`. Defaults to `5`.
- `headers`: extra HTTP headers to attach to every A2A request.
  - Header values support `file:` and `exec:` sources (same as MCP).
  - Avoid hardcoding secrets directly in YAML.

Example (bearer token loaded from an external command):

``` yaml
tools:
  - name: prod_agent
    a2a: https://example.com/agents/assistant
    headers:
      Authorization: exec:bash -lc 'echo "Bearer $(pass a2a/token)"'
```

## Tool call parameters

The tool exposes these parameters:

- `op` (required): operation mode.
  - `sendMsg`: send user text via `message/send` (or
    `message/sendStream`).
  - `getTask`: poll a long-running task via `tasks/get`.
- `text` (required for `op=sendMsg`): user text to send to the agent.
- `contextId` (optional): A2A context id to continue a conversation.
- `taskId`:
  - required for `op=getTask`
  - optional for `op=sendMsg` (some agents may attach messages to a
    task)
- `stream` (optional): override streaming for `op=sendMsg`.
- `maxWaitSeconds` (optional): override the streaming max-wait for this
  call. When exceeded, the tool returns early with a `taskId`.

## Output format

The tool returns:

1.  `text/plain`: the agent response text
2.  0 or more additional results extracted from A2A message parts and
    artifact updates:
    - `application/pdf`, `image/*`, etc. are returned as `data:` URLs
      when provided as bytes, or as a normal URL when provided as a URI.
    - `application/json` results are emitted for `data` parts.
3.  `application/json`: call metadata

The metadata includes:

- `contextId`, `taskId`: identifiers you can reuse
- `agent`: the agent name from its agent card
- `baseUrl`, `streaming`: call metadata

