

# Introduction to Lectic

Lectic is a unixy LLM toolbox. It treats conversations as plain text
files, which means you can version control them, grep them, pipe them,
email them, and edit them in whatever editor you like.

## Core Principles

### Plain text all the way down

Every conversation is a markdown file (`.lec`). Because your
conversations are files, you can do anything with them that you can do
with files:

- **Version control**: Track changes with git, branch experiments, diff
  conversations.
- **Search**: `grep` across your conversation history.
- **Process**: Pipe conversations through other tools. Combine lectic
  with `sed`, `pandoc`, or anything else.
- **Back up**: Copy files. Sync with rsync. Store wherever you want.

### Bring your own editor

Lectic includes an LSP server that provides completions, diagnostics,
hover information, go-to-definition, and folding for `.lec` files. You
can use lectic with Neovim, VS Code, or any editor that speaks LSP.

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
- **`:ask` / `:aside`**: Switch between interlocutors.
- **`:reset`**: Clear conversation context.
- **Macros**: Reusable text expansions.
- **Hooks**: Run code on events (message sent, tool called, etc.).
- **Tools**: Give the LLM capabilities (shell, database, MCP servers).

You can put these together to build all sorts of AI applications: coding
assistants, reseach and analysis workflows, orchestrated multi-agent
swarms, or simple one-shot command line text processing tools. Take a
look at the [Cookbook](./cookbook/index.qmd) for some detailed recipes.

## Quick Example

A minimal conversation:

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

A more interesting one:

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
```

The assistant can read files and search the codebase to answer.

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

All of the documentation concatinated into a single markdown file can be
found [here](./llms-full.md)



# Getting Started with Lectic

This short guide helps you install Lectic and run your first
conversation. Along the way, you will verify your install, set an API
key, and see a simple tool in action.

## Installation

Choose the method that fits your system.

#### Nix

If you use Nix, install directly from the repository:

``` bash
nix profile install github:gleachkr/lectic
```

#### Linux (AppImage)

Download the AppImage from the GitHub Releases page. Make it executable
and put it on your PATH.

``` bash
chmod +x lectic-*.AppImage
mv lectic-*.AppImage ~/.local/bin/lectic
```

#### macOS

Download the macOS binary from the [GitHub Releases
page](https://github.com/gleachkr/Lectic/releases) and put it on your
PATH.

## Verify the install

``` bash
lectic --version
```

If you see a version number, you are ready to go.

## Your first conversation

#### Set up an API key

Lectic talks to LLM providers. Put at least one provider key in your
environment so Lectic can pick a default.

``` bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

Lectic chooses a default provider by checking for keys in this order:
Anthropic, then Gemini, then OpenAI, then OpenRouter. If you need
Bedrock, set `provider: anthropic/bedrock` explicitly in your file and
make sure your AWS credentials are configured. Bedrock is not
auto‑selected.

Finally, OpenAI has two provider choices. Use `openai` for the newer
Responses API and native tools. Use `openai/chat` for the legacy Chat
Completions API when you need it.

#### Create a conversation file

Make a new file, for example `my_convo.lec`. The `.lec` extension helps
with editor integration.

Add a minimal YAML header and your first user message:

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic
  model: claude-3-haiku-20240307
  # Optional thinking controls (Anthropic/Gemini):
  # thinking_budget: 1024     # integer token budget for reasoning
---

Hello, world! What is a fun fact about the Rust programming language?
```

#### Run Lectic

From your terminal, run Lectic on the file. The `-i` flag updates the
file in place.

``` bash
lectic -i my_convo.lec
```

Lectic sends your message to the model and appends its response in a new
assistant block. You can add your next message under that block and run
the command again to continue the conversation.

#### Use a tiny tool

Now add a very small tool to see the tool flow. This one exposes `date`.

``` yaml
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic
  model: claude-3-haiku-20240307
  tools:
    - exec: date
      name: get_date
---

What is today's date?
```

Run Lectic again. The assistant block will now include an XML tool call
and the recorded results. You will see tags like , , and in the block.

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
export ANTHROPIC_API_KEY="sk-ant-..."
lectic -i my_convo.lec
```

If you set the key in a config file (like `.bashrc`), you may need to
restart your terminal or run `source ~/.bashrc`.

### Response is empty or tool calls aren’t working

Check that your YAML header is valid. Common mistakes:

- Indentation errors (YAML requires consistent spacing)
- Missing colons after keys
- Forgetting the closing `---` after the frontmatter

The LSP server catches many of these. See [Editor
Integration](./03_editor_integration.qmd) to set it up.

### “Model not found” errors

Model names vary by provider. Use `lectic models` to see what’s
available for your configured API keys. Some common model names:

- Anthropic: `claude-sonnet-4-20250514`, `claude-3-haiku-20240307`
- OpenAI: `gpt-4o`, `gpt-4o-mini`
- Gemini: `gemini-2.5-flash`, `gemini-2.5-pro`

The LSP server can autocomplete model names, so tab-complete is your
friend here.

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

# Wrong - tools at top level
interlocutor:
  name: Assistant
  prompt: You are helpful.
tools:  # This won't work
  - exec: date
```

## Next steps

Now that you have Lectic working, you’ll want to:

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
workflow is simple: edit a file, run `lectic`, get a response appended.
But with proper editor integration, you can do this with a single
keypress and get features like completions, diagnostics, and folding.

## The LSP Server

Lectic includes a Language Server Protocol (LSP) server that provides:

- **Completions** for directives (`:cmd`, `:ask`, `:reset`, etc.),
  interlocutor names, macro names, YAML header fields, and tool types
- **Diagnostics** for missing or invalid configuration, duplicate names,
  and broken file references
- **Hover information** for directives, tool calls, and file links
- **Go to definition** for macros and interlocutors
- **Folding** for tool-call and inline-attachment blocks
- **Document outline** showing conversation structure

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

## 1. YAML Frontmatter

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
  provider: anthropic
  model: claude-3-haiku-20240307
  # Optional thinking controls (Anthropic/Gemini):
  # thinking_budget: 1024     # integer token budget for reasoning
---
```

The frontmatter can be closed with either three dashes (`---`) or three
periods (`...`). For a complete guide to all available options, see the
Configuration page.

## 2. User Messages

Anything in the file that is not part of the YAML frontmatter or an
assistant response block is considered a user message. You write your
prompts, questions, and instructions here as plain text or standard
markdown.

``` markdown
This is a user message.

So is this. You can include any markdown you like, such as **bold text** or
`inline code`.
```

## 3. Assistant Responses

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

When you use directives like `:cmd[...]` in your message, Lectic
executes them and caches the results as **inline attachments**. These
within the assistant’s response block as XML chunks:

``` xml
<inline-attachment cmd="git diff --staged" type="text">
┆diff --git a/src/main.ts b/src/main.ts
┆...
</inline-attachment>
```

Inline attachments serve two purposes:

1.  **Caching**: The results are stored in the file, so re-running
    Lectic doesn’t re-execute old commands. Only `:cmd` directives in
    the most recent user message are executed.

2.  **Context positioning**: When sending the conversation to the
    provider, attachments are treated as if they were a user message
    This keeps provider caches stable and avoids token recomputation.

You’ll see inline attachments frequently when using `:cmd`. They’re part
of the conversation record and should generally be left alone. Editor
plugins typically fold them by default to reduce visual clutter.

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

- **Objects (Mappings)**: Merged recursively. If a key exists in
  multiple sources, the value from the source with higher precedence
  wins.
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
your YAML header, or let Lectic choose a default based on which API keys
are in your environment.

## Picking a default provider

If you do not set `provider`, Lectic checks for keys in this order and
uses the first one it finds:

Anthropic → Gemini → OpenAI → OpenRouter.

Set one of these environment variables before you run Lectic:

- ANTHROPIC_API_KEY
- GEMINI_API_KEY
- OPENAI_API_KEY
- OPENROUTER_API_KEY

AWS credentials for Bedrock are not used for auto‑selection. If you want
Anthropic via Bedrock, set `provider: anthropic/bedrock` explicitly and
make sure your AWS environment is configured.

## Discover models

You can list available models for providers that have API keys
configured by running:

``` bash
lectic models
```

The command prints each detected provider followed by its models. If no
known provider keys are set, it prints a short message and exits.

## OpenAI: two provider strings

OpenAI has two modes in Lectic today.

- `openai` selects the Responses API. Choose this when you want native
  tools like search and code.
- `openai/chat` selects the legacy Chat Completions API.

## Examples

Anthropic, direct API (uses `thinking_budget` when set):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic
  model: claude-3-haiku-20240307
  # Optional thinking controls (Anthropic/Gemini):
  # thinking_budget: 1024     # integer token budget for reasoning
```

Anthropic via Bedrock:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: anthropic/bedrock
  model: anthropic.claude-3-haiku-20240307-v1:0
```

OpenAI Responses API:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openai
  model: gpt-4o-mini
```

OpenAI Chat Completions:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openai/chat
  model: gpt-4o-mini
```

Gemini:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: gemini
  model: gemini-2.5-flash
```

OpenRouter:

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: openrouter
  model: meta-llama/llama-3.1-70b-instruct
```

Ollama (local inference):

``` yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  provider: ollama
  model: llama3.1
```

## Capabilities and media

Providers differ in what they accept as input. Most accept plain text
and images. Many accept PDFs and short audio clips. Support changes
quickly, so consult each provider’s documentation for current limits on
formats, sizes, page counts, and rate limits.

In Lectic, you attach external content by linking files in the user
message body. Lectic will package these and send them to the provider in
a way that fits that provider’s API. See [External
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
and an `expansion`.

``` yaml
macros:
  - name: summarize
    expansion: >
      Please provide a concise, single-paragraph summary of our
      conversation so far, focusing on the key decisions made and
      conclusions reached.

  - name: commit_msg
    expansion: |
      Please write a Conventional Commit message for the following changes:
      :cmd[git diff --staged]
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
full text from its `expansion` field *before* processing any other
directives (like `:cmd`).

``` markdown
This was a long and productive discussion. Could you wrap it up?

:summarize[]
```

## Passing arguments to expansions (ARG)

The text inside the directive brackets is passed to the macro expansion
as the `ARG` environment variable.

This works for both single-line `exec:` commands and multi-line `exec:`
scripts.

- `:name[hello]` sets `ARG=hello`.
- If you explicitly set an `ARG` attribute, it overrides the bracket
  content: `:name[hello]{ARG="override"}`.

## Passing environment variables to expansions

You can pass environment variables to a macro’s expansion by adding
attributes to the macro directive. These attributes are injected into
the environment of `exec:` expansions when they run.

- `:name[]{FOO="bar"}` sets the variable `FOO` to `bar`.
- `:name[]{EMPTY}` sets the variable `EMPTY` to be undefined. If you
  need an empty string value, write `:name[]{EMPTY=""}`.

Notes: - Single‑line `exec:` commands are not run through a shell. If
you need shell features, invoke a shell explicitly, e.g.,
`exec: bash -c 'echo "Hello, $TARGET"'`. - In single‑line commands,
variables in the command string are expanded before execution. For
multi‑line scripts, variables are available to the script via the
environment.

### Example

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



# Automation: Hooks

Hooks are a powerful automation feature that let you run custom commands
and scripts in response to events in Lectic’s lifecycle. Use them for
logging, notifications, post‑processing, or integrating with other tools
and workflows.

Hooks are defined in your YAML configuration under the `hooks` key,
per-tool in the `hooks` key of a tool specification, or per-interlocutor
in the `hooks` key of an interlocutor specification.

## Hook configuration

A hook has three fields:

- `on`: A single event name or a list of event names to listen for.
- `do`: The command or inline script to run when the event fires.
- `inline`: (Optional) A boolean. If `true`, the standard output of the
  command is captured and injected into the conversation. Defaults to
  `false`. Only applicable to `assistant_message` and `user_message`.

``` yaml
hooks:
  - on: [assistant_message, user_message]
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
  the assisant to generate more content.

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
visible output and stored as attributes on the inline block.

``` bash
#!/usr/bin/env bash
echo "LECTIC:final"
echo ""
echo "System check complete. One issue found."
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

## Command Output via `:cmd` Directive

Use `:cmd[...]` to execute a shell command and capture its stdout and
stderr. Lectic runs the command with the Bun shell. The result is
returned as an inline attachment that appears at the very top of the
next assistant block.

How it works - When you run lectic, any `:cmd[...]` found in the last
user message is executed, and the result is forwarded to the LLM. - The
result is also inserted as an inline attachment chunk at the beginning
of the generated assistant block. It looks like an XML block beginning
with `<inline-attachment ...>`. It includes the command and its content
(stdout, or an error wrapper that includes stdout and stderr). - During
provider serialization, this attachment is treated as if it were a user
message that immediately precedes the assistant’s round. This keeps
provider caches stable and avoids recomputing earlier commands. - Older
`:cmd[...]` directives are not re-executed. Their cached attachments
remain part of the transcript and are reused across runs.

Use cases - System information:
`What can you tell me about my system? :cmd[uname -a]` - Project state:
`Write a commit message: :cmd[git diff --staged]` - Data analysis:
`Compute the average: :cmd[cat data.csv | awk '...']`

Notes - Output is wrapped in XML. On success, stdout is included. On
failure, an `<error>` wrapper includes both stdout and stderr. - `:cmd`
runs with Bun’s `$` shell in the current working directory. Standard
Lectic environment variables like `LECTIC_FILE` are available. By
contrast, single‑line `exec` tools run without a shell; invoke a shell
explicitly if you need shell features. - line breaks inside of `:cmd`
are ignored so that if a `:cmd` happens to line-wrap, the newline
doesn’t affect the command to be executed.



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



# Cookbook

This section contains practical recipes showing how to combine Lectic’s
primitives to build useful workflows. Each recipe is self-contained and
can be adapted to your needs.

## Recipes

- [Coding Assistant](./01_coding_assistant.qmd): An agentic setup with
  shell tools, TypeScript checking, and human-in-the-loop confirmation.
- [Git Commit Messages](./02_commit_messages.qmd): A custom subcommand
  that generates commit messages from staged changes.
- [Research with Multiple Perspectives](./03_research_perspectives.qmd):
  Using multiple interlocutors to get different viewpoints on a problem.
- [Conversation Memory](./04_memory.qmd): Persisting conversations to
  SQLite and retrieving relevant context.
- [Context Compaction](./05_context_compaction.qmd): Automatically
  summarizing and resetting context when token limits approach.



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

- `lectic models` List available models for providers with detected API
  keys. Only providers with API keys in the environment are queried.

- `lectic script` Run an ES module file using Lectic’s internal Bun JS
  runtime. Works as a hashbang interpreter, useful for writing
  subcommands (see below), [hooks](../automation/02_hooks.qmd), and
  [exec tools](../tools/02_exec.qmd). For example:

  ``` bash
  #!/bin/env -S lectic script
  console.log("Hello from a lectic script!")
  ```

## Custom Subcommands

Lectic supports git-style custom subcommands. If you invoke
`lectic <command>`, Lectic will look for an executable named
`lectic-<command>` in the following locations (in order):

1.  The Lectic configuration directory (e.g., `~/.config/lectic/` on
    Linux).
2.  The Lectic data directory (e.g., `~/.local/share/lectic/` on Linux).
3.  Your system `PATH`.

When a custom subcommand is found, it is executed with the remaining
arguments. The subprocess inherits standard input, output, and error
streams, and receives standard Lectic environment variables (like
`LECTIC_CONFIG` and `LECTIC_DATA`).

For example, if you create a script named `lectic-hello` in your path:

``` bash
#!/bin/bash
echo "Hello from a custom subcommand!"
```

You can run it via:

``` bash
lectic hello
```

This mechanism allows you to extend Lectic with your own tools and
workflows.

## Bash completion

The repository includes a bash completion script at:

- `extra/tab_complete/lectic_completion.bash`

Source it from your `~/.bashrc`:

``` bash
source /path/to/lectic_completion.bash
```

### Custom completion functions for custom subcommands

You can attach a completion function to a custom subcommand by creating
a plugin file. Plugins are sourced when the completion script is loaded.

Supported locations:

- `${XDG_CONFIG_HOME:-$HOME/.config}/lectic/completions/*.bash`
- `${XDG_DATA_HOME:-$HOME/.local/share}/lectic/completions/*.bash`
- Next to the subcommand executable as: `lectic-<cmd>.completion.bash`

A plugin should define a completion function and register it:

``` bash
_lectic_complete_foo() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "--help --verbose" -- "${cur}") )
}

lectic_register_completion foo _lectic_complete_foo
```

The repository includes an example completion plugin for the `worktree`
subcommand at `extra/sandbox/lectic-worktree.completion.bash`. \## Flags
and options

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
  the tool’s own `sandbox` setting.

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

- One of: `mcp_command`, `mcp_ws`, `mcp_sse`, or `mcp_shttp`.
- `args`: Arguments for `mcp_command`.
- `env`: Environment variables for `mcp_command`.
- `sandbox`: Optional wrapper command to isolate `mcp_command` servers.
- `roots`: Optional list of root objects for file access (each with
  `uri` and optional `name`).
- `exclude`: Optional list of server tool names to hide.

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
- `expansion`: (Required) The content to be expanded. Can be a string,
  or loaded via `file:` or `exec:`. See [External
  Prompts](../context_management/03_external_prompts.qmd) for details.

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

# LSP Server (Experimental)


Lectic includes a small Language Server Protocol (LSP) server that
provides completion for directives, macros, and common YAML header
fields, plus hovers. It is stdio only.

Overview - Command: `lectic lsp` - Transport: stdio (no `--node-ipc` or
`--socket`) - Features: `textDocument/completion`, `textDocument/hover`,
diagnostics, document symbols (outline), workspace symbols, folding
ranges, code actions, semantic tokens, go to definition - Triggers: `:`,
`[` in directive brackets, and `-` in tools arrays - Insertions -
Directives use snippets and place the cursor inside brackets (or at the
end for reset): `:cmd[${0:command}]`, `:ask[$0]`, `:aside[$0]`,
`:reset[]$0`. - Macro names are suggested on `:` and insert as
directives: `:name[]$0`. - Inside brackets of `:ask[...]` and
`:aside[...]`, only interlocutor names are offered. - Matching:
case‑insensitive; typed prefix after `:` or inside `[` is respected. -
Fences: no suggestions inside `::` or `:::` runs - Trigger filtering:
only `:ask[`/`:aside[` produce bracket completions

Where completions come from - Directives: built‑in suggestions for
`:cmd`, `:ask`, `:aside`, and `:reset`. - Macro names: merged from the
same places and precedence as the CLI (higher wins): 1) System config:
`${LECTIC_CONFIG}/lectic.yaml` 2) Workspace config: `lectic.yaml` in the
document directory 3) The document’s YAML header - YAML header fields: -
`interlocutor` / `interlocutors` blocks: top‑level interlocutor
properties such as `name`, `prompt`, `provider`, `model`, `temperature`,
`max_tokens`, `max_tool_use`, `thinking_effort`, `thinking_budget`,
`tools`, and `nocache`. - `model`: provider‑appropriate model names. -
`tools` array items: tool kinds after a bare `-`. - `kit: ...`: merged
kit names from system/workspace/header. - `agent: ...`: merged
interlocutor names. - `native: ...`: supported native types (`search`,
`code`). - Interlocutors: collected from the merged header as above,
combining `interlocutor` and `interlocutors`. - De‑duplication is
case‑insensitive on name. Higher‑precedence entry wins. - The server
shows a simple preview in the completion item.

Behavior examples - Type `-` on a line inside `tools:` → suggestions for
tool kinds (exec, sqlite, mcp\_\*, native, kit, …). - Type `:` →
suggestions for directives and macro names. - Type `:su` (with a
`summarize` macro defined) → `summarize` appears and inserts
`:summarize[]$0`. - Type `:ask[` or `:aside[` → invoke completion to see
interlocutor names; selecting a name replaces only the text inside the
`[`…`]`. - Type `::` or `:::` → no suggestions (reserved for directive
fences). - Place the cursor on a directive (e.g., `:name[]`,
`:ask[Name]`) or a name field in the YAML header (e.g.,
`name: Assistant`) and invoke “Go to Definition” to jump to the relevant
definition. If multiple definitions exist (e.g., a local override of a
workspace or system interlocutor), the LSP returns all locations,
prioritized by proximity (local \> workspace \> system).

Neovim setup (vim.lsp.start) - Minimal startup for the current buffer:

``` lua
local client_id = vim.lsp.start({
  name = "lectic",
  cmd = { "lectic", "lsp" },
  root_dir = vim.fs.root(0, { ".git", "lectic.yaml" })
             or vim.fn.getcwd(),
  single_file_support = true,
})
```

- Auto‑start for `.lec` (and optionally markdown) files:

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

- Using completion
  - With nvim‑cmp (recommended), LSP completion pops on `:` and `-`.
  - Inside brackets, invoke completion manually (`Ctrl‑x Ctrl‑o`) if
    your setup is not configured to trigger automatically.

VS Code setup - The server is an external stdio LSP. You can connect to
it from a VS Code extension. The repository includes
`extra/lectic.vscode` for a ready‑made extension.

Diagnostics - The server publishes diagnostics on open/change. - Header
field validation covers missing or mistyped interlocutor properties
(name, prompt, model, provider, etc.). Unknown top‑level properties on
an interlocutor are reported as warnings (for example,
`Unknown property "mood" on interlocutor A.`). - Duplicate names in the
document header are warned with precise ranges. Later entries win at
runtime; the warning helps catch mistakes. - Duplicates originating only
from included configs may be reported with a coarse header-range
warning.

Folding - The LSP provides folding ranges for tool‑call and
inline‑attachment blocks. A block must be a serialized
`<tool-call ...> ... </tool-call>` or
`<inline-attachment ...> ... </inline-attachment>` that appears as a
direct child of an interlocutor container directive (`:::Name`).

Hovers - Hover over a directive (e.g., `:ask[...]`) to see a short
description. - Hover on a macro directive name (e.g., `:summarize[]`) to
preview the macro expansion.

Notes - Completion previews are static; the server does not expand
macros or read files referenced by `file:`.



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

Reuse tool sets across interlocutors by defining named kits:

``` yaml
kits:
  - name: typescript_tools
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
  Overrides any interlocutor-level sandbox.
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

For example, `extra/sandbox/bwrap-sandbox.sh` uses Bubblewrap to create
a minimal, isolated environment with a temporary home directory.

You can also set a default `sandbox` on the `interlocutor` object. If
set, it applies to all `exec` tools that don’t specify their own.



# Tools: SQLite Query

The `sqlite` tool gives your LLM the ability to query SQLite databases
directly. This is a powerful way to provide access to structured data,
allowing the LLM to perform data analysis, answer questions from a
knowledge base, or check the state of an application.

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

You can find lists of available servers here: - [Official MCP Server
List](https://github.com/modelcontextprotocol/servers) - [Awesome MCP
Servers](https://github.com/punkpeye/awesome-mcp-servers)

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
- `mcp_sse`: The URL for a remote server using Server-Sent Events.
- `mcp_shttp`: The URL for a remote server using Streamable HTTP.

For example:

``` yaml
tools:
  - name: documentation_search 
    mcp_shttp: https://mcp.context7.com/mcp
```

### Server Resources and Content References

If you give an MCP tool a `name` (e.g., `name: brave`), you can access
any [resources](https://modelcontextprotocol.io/docs/concepts/resources)
it provides using a special content reference syntax. The scheme is the
server’s name plus the resource type.

For example, to access a `repo` resource from a server named `github`:
`[README](github+repo://gleachkr/Lectic/contents/README.md)`

The LLM is also given a tool to list the available resources from the
server.

### Excluding server tools

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
details on how sandboxing scripts work.

You can also set a default `sandbox` on the `interlocutor` object. If
set, it applies to all local MCP tools that don’t specify their own.



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

The `serve` tool allows the LLM to spin up a simple, single-use web
server to present content, such as an HTML file or a small web
application it has generated.

When the LLM uses this tool, Lectic starts a server on the specified
port. It will then attempt to open the page in your default web browser.
The server shuts down automatically after the first request is served.
While the page is loading, Lectic waits for the first request—so the
conversation resumes once your browser has loaded the page.

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

