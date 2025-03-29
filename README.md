# Lectic: A Tool for Persistent LLM Conversations

Lectic is a markdown-based frontend for Large Language Models (LLMs), designed
for thoughtful, long-form conversations that can be easily archived, searched,
and referenced. Unlike ephemeral chat interfaces or code-focused LLM tools,
Lectic emphasizes persistence and reflection, making it particularly valuable
for research, learning, and knowledge management.

## Getting Started

### Installation

If you're using [nix](https://nixos.org), then `nix profile install github:gleachkr/lectic` 
will install lectic from the lastest git commit. If you're not using nix, but
you're using a Linux system (or WSL on windows), you can download an app image
from the [releases](https://github.com/gleachkr/Lectic/releases), and place it
somewhere on your `$PATH`.

### Basic Workflow

1. Create a new conversation file with a YAML header:

   ```yaml
   ---
   interlocutor:
       name: Assistant
       provider: anthropic|openai|ollama|gemini
       prompt: Your base prompt here
   ---

   Your initial message here
   ``` 

   To use the anthropic or openai providers, you'll need `ANTHROPIC_API_KEY` or
   `OPENAI_API_KEY` set in your environment.

2. Use your text editor to interact with the LLM:
   - In Vim: Use `%!lectic` to update the conversation
   - In other editors: Set up a key binding or command to pipe the current file
     through `lectic`

3. Or, From the command line: `lectic -f conversation.lec > tmp && mv tmp
   conversation.lec`

### Editor Integration

#### Neovim

A Neovim plugin is provided in `extra/lectic.nvim` that offers: 
* support for the `.lec` filetype
- The `:Lectic` command to update conversations
- Automatic highlighting of LLM responses
- Cursor placement at the end of the conversation after updates

#### Other Editors

Most text editors support filtering through external commands. Consider:
- Setting up key bindings for frequent operations
- Using markdown preview features
- Taking advantage of folding for longer conversations

## Features

### Markdown Format

Lectic uses a superset of commonmark markdown, using micromark's implementation
of *[container
directives](https://github.com/microma/syrk/micromark-extension-directive?tab=readme-ov-file#syntax)*
to represent LLM responses. These allow the insertion of special blocks of
content, opened by a sequence of colons followed by an alphanumeric name, and
closed by a matching sequence of colons. For example:

````markdown
Your question or prompt here

:::Assistant

The LLM's response appears here, wrapped in fenced div markers.
Multiple paragraphs are preserved.

Code blocks and other markdown features work normally:

```python
print("Hello, world!")
```

:::

Your next prompt...
````

The front matter should be YAML, and should open with three dashes and close
with three dashes or three periods.

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
- PDFs (anthropic and gemini providers only right now)
- Remote content via HTTP/HTTPS
- Large files or failed remote fetches will produce error messages in context

Local content references can also use globbing to include multiple files:

```markdown
[Code](./src/**)
[Images](./images/*.jpg)
```

Supported glob syntax is determined by bun's [glob
api](https://bun.sh/docs/api/glob).

### Command Output References

Include the output of shell commands directly in your conversations by using a
markdown directive.

```markdown
:cmd[uname -a]                  #add system info to context
:cmd[ls]                        #add directory contents to context
:cmd[git diff]                  #add the latest diff to the context
:cmd[ps aux | grep python]      #add the output of a pipeline to the context
```

When Lectic encounters a `cmd` [directive](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444), 
(inline text of the form `:cmd[COMMAND]`) it:
1. Executes the specified command (using the [bun
   shell](https://bun.sh/docs/runtime/shell)).
2. Captures the output
3. Includes the output in the user message.

This is particularly useful for:
- Including system information in debugging conversations
- Showing the current state of a project or environment
- Incorporating dynamic data into your conversations
- Running analysis tools and discussing their output

### Memory Consolidation

Lectic can consolidate the memories of a conversation into the YAML header,
allowing the LLM to retain context from previous interactions. This feature
summarizes the conversation so far and stores it in the `memories` field of
the YAML header.

To use this feature, use the `-c` or `--consolidate` flag:

```bash
lectic -c -f conversation-today.lec > conversation-tomorrow.lec
```

This command will:

1.  Send the current conversation to the LLM.
2.  Instruct the LLM to summarize the conversation, combining any existing
    memories with the current discussion.
3.  Update the YAML header with the summarized memory in the
    `interlocutor.memories` field.

The updated YAML header will look something like this:

````yaml
interlocutor:
    name: Assistant
    provider: anthropic
    prompt: Your base prompt here
    memories:
        3/28/2025-9:01:24 AM: >-
          This is a summary of the conversation so far, including
          key details and topics discussed. It will be used to
          maintain context in future interactions.

````

The quality of the memory consolidation depends on the LLM's ability to
summarize the conversation effectively.

### Tools

#### Command Execution Tool

The exec tool allows the LLM to execute commands directly. For security, you can
configure which commands are available and optionally run them in a sandbox.

```yaml
tools:
    - exec: python3             # Allow LLM to run Python
      name: python              # Optional custom name
      usage: "Usage guide..."   # Instructions for the LLM
      sandbox: ./sandbox.sh     # Optional sandboxing script

    - exec: git status         # Another allowed command
      name: git-status         # Custom name for this specific command
```

When configured with a sandbox script, the command and its arguments are passed to
the sandbox script which is responsible for executing them in a controlled
environment. For example, the provided `extra/bwrap-sandbox.sh` uses bubblewrap
to create a basic sandbox with a temporary home directory.

Example conversation using the exec tool:

```markdown
Could you check if this code works?

:::Assistant

I'll test it using Python:

{python}
print("Hello, world!")
{/python}

The code executed successfully and output: Hello, world!

:::
```

#### SQLite Query Tool

The sqlite tool gives the LLM the ability to query SQLite databases. You can
configure limits and provide schema documentation. The schema is automatically
supplied to the LLM.

```yaml
tools:
    - sqlite: ./data.db         # Path to SQLite database
      name: query               # Optional custom name
      limit: 10000              # Maximum size of serialized response
      details: this contains... # Extra details about the DB
```

Example conversation using the sqlite tool:

```markdown
What are the top 5 orders by value?

:::Assistant

I'll query the orders table:

{query}
SELECT 
    order_id,
    total_value
FROM orders
ORDER BY total_value DESC
LIMIT 5;
{/query}

Here are the results showing the largest orders...

:::
```

#### Tavily Search Tool

If you have a [tavily](https://tavily.com) API key, The tavily tool provides
access to real-time search engine results, allowing the LLM to answer questions
using up-to-date information from the web. You need to have `$TAVILY_API_KEY`
set in your environment or provide the API key in the lectic. Parameters are
based on the [tavily API](https://docs.tavily.com/documentation/api-reference/endpoint/search).

```yaml
tools:
    - tavily_search: basic          # "basic" or "advanced" search (required)
      name: search                  # Optional custom name
      max_results: 5                # Max number of results (0-20)
      time_range: week              # "day", "week", "month", "year"
      topic: news                   # "general" or "news"
      include_raw_content: false    # Include raw HTML from sources
      include_domains:              # Limit search to these domains
        - example.com
        - example.org
      exclude_domains:              # Exclude these domains
        - bad-example.com
      api_key: YOUR_API_KEY         # Optional Tavily API Key
```

Example conversation using the tavily tool:

```markdown
What are the latest headlines about AI ethics?

:::Assistant

I'll search for recent news articles on AI ethics:

{search}
What are the latest headlines about AI ethics?
{/search}

Here are some of the top headlines:
- Article 1: ...
- Article 2: ...

:::
```

#### Think Tool

This tool lets you give your LLM an opportunity to deliberately pause and think
about something, in the style suggested by [anthropic's engineering
blog](https://www.anthropic.com/engineering/claude-think-tool). It provides the
LLM with some "scratch space" to think a little bit before speaking "out loud".

```yaml
tools:
    - think_about: what the user is really asking   # A thing to think about
      name: thinker                                 # Optional custom name
      usage: Use this whenever user is imprecise.   # Optional extra usage advice
```

Example conversation using the think tool:

```markdown
So what's the best place in Boston?

:::Assistant

Hmmm....

{think}
What are they really asking? What might "best" mean? That probably depends on
what kind of place they're interested in. Do they want to know about the best
places to visit, to live, to work? I had better ask.
{/think}

What kind of place are you interested in? Places to live, places to work,
places to visit, or something else?

:::
```

## Configuration Reference

```yaml
interlocutor:
    # Required fields
    name: Assistant              # Name shown in responses
    prompt: Base prompt          # Core personality/instruction
                                 # Can be string or file path

    # Optional model configuration
    provider: anthropic         # Optional, default anthropic
    model: claude-3-7-sonnet    # Model selection
    temperature: 0.7            # Response variability (0-1)
    max_tokens: 1024            # Maximum response length

    # Optional Context management
    memories: previous.txt      # Context from previous conversations.
                                # Added to system prompt.
                                # Can be string or file path

    reminder: Be nice.          # Reminder string, added to 
                                # user message invisibly.
                                
    # Tool integration
    tools:
        # Command execution tool
        - exec: python3         # Command to execute
          name: python          # Optional custom name
          usage: "Usage: ..."   # String or file path for usage guide

        # Database tool
        - sqlite: data.db       # Database file
          name: query           # Optional custom name
          limit: 10000          # Max result size
          details: schema.txt   # Optional DB documentation
```

## Example Conversation

````markdown
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

:::Mathematician

The Fibonacci sequence is a series of numbers where each number is the sum
of the two preceding ones. Usually, the sequence starts with 0 and 1.

Let's calculate the first 10 terms. I'll use Python to help us:

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        print(a, end=' ')
        a, b = b, a + b

fib(10)
```

Here are the first 10 terms:
0 1 1 2 3 5 8 13 21 34

Each number is the sum of the two before it. For example:
- 1 + 1 = 2
- 1 + 2 = 3
- 2 + 3 = 5
And so on...

:::

That's interesting! What's the ratio between consecutive terms?

:::Mathematician

The ratio between consecutive Fibonacci numbers approaches the golden ratio
(φ ≈ 1.618033988749895). Let's calculate these ratios:

```python
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
```

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

````

## Command Line Interface
```bash
lectic -f conversation.lec                 # Process a conversation file
lectic -l debug.log -f conversation.lec    # Write debug logs to debug.log
lectic -s -f convo.lec                     # Only show the last message
cat convo.lec | lectic -                   # Read from stdin
```

## Best Practices

- Organize conversations in topic-based directories
- Use descriptive filenames for easier searching
- Consider using git for version control
- Use tools like ripgrep for searching across conversations
- Keep conversations focused on specific topics or learning goals

## Current Limitations

- One LLM participant per conversation (multi-LLM support planned)

## Contributing

Lectic is open to contributions. Areas of particular interest:
- Additional LLM backend support
- More Editor integrations
- New tool types
- Good lectic templates
- Documentation improvements
