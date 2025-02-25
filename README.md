# Lectic: A Tool for Persistent LLM Conversations

Lectic is a markdown-based frontend for Large Language Models (LLMs), designed
for thoughtful, long-form conversations that can be easily archived, searched,
and referenced. Unlike ephemeral chat interfaces or code-focused LLM tools,
Lectic emphasizes persistence and reflection, making it particularly valuable
for research, learning, and knowledge management.

## Getting Started

### Basic Workflow
1. Create a new conversation file with a YAML header:
   ```yaml
   ---
   interlocutor:
       name: Assistant
       prompt: Your base prompt here
   ---

   Your initial message here
   ```

2. Use your text editor to interact with the LLM:
   - In Vim: Use `%!lectic` to update the conversation
   - In other editors: Set up a key binding or command to pipe the current file
     through `lectic`
   - From the command line: `lectic -f conversation.md > tmp && mv tmp
     conversation.md`

### Editor Integration

#### Vim
A Vim plugin is provided in `extra/lectic.vim` that offers:
- The `:Lectic` command to update conversations
- Automatic highlighting of LLM responses
- Cursor placement at the end of the conversation after updates

Install by adding to your `.vimrc`:
```vim
source path/to/lectic/extra/lectic.vim
```

#### Other Editors
Most text editors support filtering through external commands. Consider:
- Setting up key bindings for frequent operations
- Using markdown preview features
- Taking advantage of folding for longer conversations

## Features

### Markdown-Based Conversations
- Each conversation is stored in a single, human-readable markdown file
- Uses standard pandoc-style fenced divs for message formatting
- Easy to version control, search, and edit with standard text tools

### Flexible Configuration
Each conversation file includes a YAML header that configures:
```yaml
interlocutor:
    name: Assistant              # Name shown in responses
    prompt: Base prompt          # Core personality/instruction
    model: claude-3-5-sonnet    # Model selection
    temperature: 0.7            # Response variability
    max_tokens: 1024            # Maximum response length
    memories: previous.txt      # Context from other conversations
```

### Tool Integration
Enrich conversations with external tools:
```yaml
interlocutor:
    name: Assistant
    prompt: Your prompt
    tools:
        - exec: calculator       # Run command-line tools
          usage: calc_help.txt   # Optional usage documentation
        
        - sqlite: database.db    # Query SQLite databases
          limit: 10000          # Maximum result size
```

### Content Handling
Include and reference various content types:
```markdown
[Document Title](path/to/file.pdf)
[Image Description](path/to/image.png)
```

Supports:
- Text documents
- Images (PNG, JPEG, GIF, WebP)
- PDFs
- Automatic content type detection

## Command Line Interface
```bash
lectic -f conversation.md    # Process a conversation file
lectic -s -f convo.md       # Only show the last message
cat convo.md | lectic -     # Read from stdin
```

## Best Practices

- Organize conversations in topic-based directories
- Use descriptive filenames for easier searching
- Consider using git for version control
- Use tools like ripgrep for searching across conversations
- Keep conversations focused on specific topics or learning goals

## Current Limitations

- Currently supports only Anthropic's Claude models
- One LLM participant per conversation (multi-LLM support planned)
- No built-in conversation linking (use standard markdown links)
- Requires ANTHROPIC_API_KEY environment variable

## Contributing

Lectic is open to contributions. Areas of particular interest:
- Additional LLM backend support
- Editor integrations
- New tool types
- Documentation improvements
