# Lectic

Lectic is a unixy LLM toolbox. It treats conversations as ordinary 
human-readable markdown files, so that you can version control them, grep them, 
pipe them, edit them, and interact with LLMs in whatever editor you like.

```bash
# Continue a conversation
lectic -i chat.lec

# Pipe in a question
echo "Summarize this: $(cat notes.md)" | lectic -f template.lec

# Use it in scripts
git diff --staged | lectic -f commit-msg.lec -S >> commits.log
```

## Why Lectic?

**Bring your own editor.** Lectic has LSP support, so you get completions,
diagnostics, code actions, and folding in Neovim, VS Code, or anything else 
that speaks LSP.

**Bring your own language.** Tools, hooks, and macros are just executables.
Write them in Bash, Python, Rust — whatever you want.

**Composable primitives.** A small set of building blocks (directives, macros, 
and hooks) combine to handle a wide range of workflows.

**Plain text all the way down.** Conversations are commonmark markdown files 
(with directives), easy to read, parse, modify, share, search, archive, and 
more.

**Sensible Sandboxing.** Lectic lets you sandbox your LLM with any strategy or 
combination of strategies you want: worktrees, bwrap, containers, or file 
permissions.

**Git style subcommands** Lectic is extensible with git style subcommands - 
executables that live on your PATH or in Lectic's configuration directories. 
LLMs are great at writing small self-contained programs against a simple API 
surface. So that's how you extend Lectic.

## Installation

#### Nix

```bash
nix profile install github:gleachkr/lectic
```

#### Linux (AppImage)

```bash
# Download from GitHub Releases, then:
chmod +x lectic-*.AppImage
mv lectic-*.AppImage ~/.local/bin/lectic
```

#### macOS

Download the macOS binary from
[GitHub Releases](https://github.com/gleachkr/Lectic/releases) and add it
to your PATH.

## Quick Start

1. Set an API key:

```bash
export ANTHROPIC_API_KEY="your-key"
# Or: GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
```

2. Create a file called `chat.lec`:

```markdown
---
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
---

What's the weather like on Mars?
```

3. Run Lectic:

```bash
lectic -i chat.lec
```

Lectic appends the response to the file. Add another message and run again
to continue the conversation.

## A Taste of What's Possible

### Run commands and include their output

```markdown
What do you make of this diff?

:cmd[git diff HEAD~1]
```

### Give the LLM tools

```yaml
interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  tools:
    - exec: rg --json
      name: search
      usage: Search the codebase. Pass search patterns as arguments.
    - sqlite: ./analytics.db
      name: query
      readonly: true
```

### Multiple interlocutors

```yaml
interlocutors:
  - name: Writer
    prompt: You are a creative writer.
  - name: Editor
    prompt: You are a critical editor. Be harsh but constructive.
```

```markdown
:ask[Writer] Write a short poem about the sea.

:::Writer
The waves roll in, the waves roll out...
:::

:aside[Editor] What do you think of this?

:::Editor
The opening line is clichéd. Consider a more striking image.
:::
```

### Automate with hooks

```yaml
hooks:
  - on: assistant_message
    do: |
      #!/bin/bash
      if [[ "$TOOL_USE_DONE" == "1" ]]; then
        notify-send "Lectic" "Done"
      fi
```

### Extend with custom subcommands

Drop a script called `lectic-review` in `~/.config/lectic/` or on your
PATH:

```bash
#!/bin/bash
git diff --staged | lectic -f ~/.config/lectic/review-prompt.lec -S
```

Then run `lectic review`.

## Editor Integration

Lectic includes an LSP server (`lectic lsp`) that provides completions,
diagnostics, hover information, go-to-definition, and folding.

- **Neovim**: Full plugin at `extra/lectic.nvim`
- **VS Code**: Extension at `extra/lectic.vscode`
- **Other editors**: Any editor that can run an external command on the
  buffer works. The LSP makes it better.

## Documentation

Full documentation is at
**[gleachkr.github.io/Lectic](https://gleachkr.github.io/Lectic)**.

- [Getting Started](https://gleachkr.github.io/Lectic/02_getting_started.html)
- [Configuration](https://gleachkr.github.io/Lectic/04_configuration.html)
- [Tools](https://gleachkr.github.io/Lectic/tools/01_overview.html)
- [Cookbook](https://gleachkr.github.io/Lectic/cookbook/index.html) — recipes 
  for using lectic in a variety of ways.

## License

MIT
