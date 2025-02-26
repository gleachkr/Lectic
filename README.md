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

### Markdown Format
Lectic uses pandoc-compatible markdown, with LLM responses formatted as fenced
divs:

```markdown
Your question or prompt here

::: Assistant
The LLM's response appears here, wrapped in fenced div markers.
Multiple paragraphs are preserved.

Code blocks and other markdown features work normally:
```python
print("Hello, world!")
```
:::

Your next prompt...
```

### Content References
Include local or remote content in conversations:

```markdown
[Local Document](./notes.pdf)
[Remote Paper](https://arxiv.org/pdf/2201.12345.pdf)
[Web Image](https://example.com/diagram.png)
[Local Data](./results.csv)
```

Supported content types:
- Text files (automatically included as plain text)
- Images (PNG, JPEG, GIF, WebP)
- PDFs (included with title for reference)
- Remote content via HTTP/HTTPS
- Large files or failed remote fetches will produce error messages in context

### Configuration Reference

```yaml
interlocutor:
    # Required fields
    name: Assistant              # Name shown in responses
    prompt: Base prompt          # Core personality/instruction
                                # Can be string or file path

    # Optional model configuration
    model: claude-3-5-sonnet    # Model selection
    temperature: 0.7            # Response variability (0-1)
    max_tokens: 1024            # Maximum response length

    # Context management
    memories: previous.txt      # Additional context
                               # Can be string or file path
    
    # Tool integration
    tools:
        # Command execution tool
        - exec: python3         # Command to execute
          name: python          # Optional custom name
          usage: "Usage: ..."   # String or file path for usage guide

        # Database tool
        - sqlite: data.db       # Database file
          name: query          # Optional custom name
          limit: 10000         # Max result size
          details: schema.txt  # Optional DB documentation
```

### Example Conversation

```markdown
---
interlocutor:
    name: Mathematician
    prompt: >
      You are a mathematics tutor, focusing on clear explanations
      and step-by-step problem solving.
    tools:
        - exec: python3
        - usage: Before running any code, show the code snippet to the user.
---

Can you help me understand the Fibonacci sequence? Maybe we could
calculate some terms?

::: Mathematician
The Fibonacci sequence is a series of numbers where each number is the sum
of the two preceding ones. Usually, the sequence starts with 0 and 1.

Let's calculate the first 10 terms. I'll use Python to help us:

    def fib(n):
        a, b = 0, 1
        for _ in range(n):
            print(a, end=' ')
            a, b = b, a + b

    fib(10)

Here are the first 10 terms:
0 1 1 2 3 5 8 13 21 34

Each number is the sum of the two before it. For example:
- 1 + 1 = 2
- 1 + 2 = 3
- 2 + 3 = 5
And so on...
:::

That's interesting! What's the ratio between consecutive terms?

::: Mathematician
The ratio between consecutive Fibonacci numbers approaches the golden ratio
(φ ≈ 1.618033988749895). Let's calculate these ratios:

    def fib_ratios(n):
        a, b = 0, 1
        fibs = []
        for _ in range(n):
            fibs.append(a)
            a, b = b, a + b
        
        print("Term Ratio")
        print("-----------")
        for i in range(1, len(fibs)):
            if fibs[i-1] != 0:
                ratio = fibs[i] / fibs[i-1]
                print(f"{i:4d} {ratio:.6f}")

    fib_ratios(10)

Here we can see how the ratios converge to φ:
Term Ratio
-----------
   2 1.000000
   3 2.000000
   4 1.500000
   5 1.666667
   6 1.600000
   7 1.625000
   8 1.615385
   9 1.619048

Notice how each ratio gets closer to the golden ratio!
:::

```

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
