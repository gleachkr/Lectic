# Lectic: A Conversational LLM Client

Lectic is a no-nonsense, file-based conversational LLM client. Each
conversation is a simple markdown file, making it persistent,
version-controllable, and easy to manage with your existing text-based tools.

Lectic is designed for research, reflection, self-study, and design. It allows
you to bring multiple LLMs into a single conversation, integrate with external
tools and data sources, and automate repetitive tasks, all from the comfort of
your favorite text editor.

## Key Features

- **File-Based Conversations**: Every chat is a `.lec` markdown file.
- **Multiparty Chats**: Seamlessly switch between different LLMs.
- **Powerful Tooling**: Extend your LLM with shell commands, database access,
  MCP servers, and more.
- **Context Management**: Easily include files, web pages, and command output
  in your conversations.
- **Automation**: Use macros and hooks to streamline your workflows.
- **Editor Integration**: First-class support for Neovim and VSCode, with
  integrations possible for any editor that can pipe text to a command.

## Getting Started

To get started with Lectic, check out our documentation:

- **[Introduction](https://gleachkr.github.io/Lectic/01_introduction.qmd)**: 
  Learn more about the
  philosophy behind Lectic.
- **[Getting Started 
  Guide](https://gleachkr.github.io/Lectic/02_getting_started.qmd)**: Install 
  Lectic and
  create your first conversation.

## How It Works

Lectic processes a markdown file (`.lec`) containing your conversation. You
add a new message, then run `lectic` on the file. Lectic sends the
conversation to the specified LLM and appends the response to the file.

A simple conversation looks like this:

```markdown
---
interlocutor:
  name: Assistant
  provider: anthropic
  model: claude-3-haiku-20240307
---

What is the capital of France?

:::Assistant

The capital of France is Paris.

:::
```

To learn more about the conversation format, configuration, and features, 
please dive into the full **[documentation](https://gleachkr.github.io/Lectic)**.
