# Lectic

Lectic is no-nonsense conversational LLM client. Each conversation is a simple 
markdown file. That means that each conversation is naturally persistent and 
can be easily version-controlled, searched, referenced, and managed with 
existing markdown tools. Lectic aims to support research, reflection, 
self-study, and design. So Lectic makes it easy to manage conversational 
context using content references, integrate with MCP servers and other tools 
(for search, computation, database access, and more) and include multiple LLMs 
in a single conversation in order to bring a variety of perspectives to bear on 
a problem.

## Getting Started

### Installation

- If you're using [nix](https://nixos.org), then `nix profile install 
  github:gleachkr/lectic` will install lectic from the lastest git commit. 
- If you're not using nix, but you're using a Linux system (or WSL on windows), 
  you can download an app image from the 
  [releases](https://github.com/gleachkr/Lectic/releases), and place it 
  somewhere on your `$PATH`. 
- If you're on MacOS, you can download a binary from the 
  [releases](https://github.com/gleachkr/Lectic/releases), and place it 
  somewhere on your `$PATH`.

### Basic Workflow

1. Create a new conversation file with a YAML header:

   ```yaml
   ---
   interlocutor:
       name: Assistant
       provider: anthropic|openai|gemini|openrouter|ollama
       prompt: Your base prompt here
   ---

   Your initial message here
   ``` 

   To use the remote providers , you'll need `ANTHROPIC_API_KEY`, 
   `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` set in your 
   environment. If the provider field is omitted, the default provider will be 
   based on the alphabetically first API key defined in the your environment.

2. Use your text editor to interact with the LLM:
   - In Vim: Use `%!lectic` to update the conversation
   - In other editors: Set up a key binding or command to pipe the current file
     through `lectic`

3. Or, From the command line: `lectic -s -f conversation.lec` will stream a 
   next message to the console, and `lectic -i conversation.lec` will update 
   the lectic file in-place.

### Editor Integration

<details>
<summary>

#### Neovim

</summary>

A Neovim plugin is provided in `extra/lectic.nvim` that offers support for the 
`.lec` filetype, including syntax highlighting, streaming responses, folding of 
tool use blocks, keymaps, and commands for updating conversations, 
consolidating memories, and elaborating model responses. For more details, 
check out the 
[README](https://github.com/gleachkr/Lectic/blob/main/extra/lectic.nvim/README.md)

</details>

<details>
<summary>

#### VSCode

</summary>

A VSCode plugin is provided in `extra/lectic.vscode` that offers support for 
the `.lec` filetype, including syntax highlighting, streaming responses, 
folding of tool use blocks, keymaps, and commands for updating conversations, 
consolidating memories, and elaborating model responses. For more details, 
check out the 
[README](https://github.com/gleachkr/Lectic/blob/main/extra/lectic.vscode/README.md)

</details>

<details>
<summary>

#### Other Editors

</summary>

Most text editors support piping through external commands, like linters and 
code formatting tools. You can use lectic in the same way you would use one of 
those tools: by sending the buffer to lectic on stdin, and replacing the buffer 
contents with the result from stdout.

</details>

## Features

### Markdown Format

Lectic uses a superset of commonmark markdown, using micromark's implementation
of *[container
directives](https://github.com/micromark/micromark-extension-directive?tab=readme-ov-file#syntax)*
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

### Multiparty Conversations

Instead of specifying a single interlocutor in the `interlocutor` field, you 
can specify a list of interlocutors. The conversation will continue with the 
last active interlocutor unless you use an `:ask[NAME]` directive (see below 
for more about directives) to switch to a new interlocutor.

````markdown
---
interlocutors:
   - name: Boggle
     provider: anthropic
     prompt: You're trying to teach Oggle about personal finance.
   - name: Oggle
     provider: gemini
     prompt: You're very skeptical of everything Boggle says.
...

So Boggle, what should Oggle know about timing the market?

:::Boggle

Essentially, don't try.

:::

:ask[Oggle] And what do you think about that?

:::Oggle

Nonsense! …

:::
````

### Content References

Include local or remote content in conversations:

```markdown
[Local Document](./notes.pdf)
[Remote Paper](https://arxiv.org/pdf/2201.12345.pdf)
[Web Image](https://example.com/diagram.png)
[Web Image](s3://my_bucket/dataset.csv)
[MCP Resource](github+repo://gleachkr/Lectic/contents/README.md)
[Local Data](./results.csv)
```

Supported content types:
- Text files (automatically included as plain text)
- Images (PNG, JPEG, GIF, WebP)
- PDFs (Anthropic, Gemini, and OpenAI providers only right now)
- Video (Gemini only right now - Supported mime types 
  [here](https://ai.google.dev/gemini-api/docs/video-understanding#supported-formats))
- Audio (Gemini, and OpenAI providers only right now. MP3, MPEG and WAV, more 
  for gemini. OpenAI requires an audio model)

Remote content can be included via HTTP/HTTPS, or from an amazon s3 bucket. 
Using s3 requires that you have `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` 
set in your environment - this uses Bun's [s3 
support](https://bun.sh/docs/api/s3#credentials) under the hood. Failed remote 
fetches will produce error messages visible to the LLM.

MCP resources can be accessed using content references. In order to identify 
the server, you need to prefix the server's name, followed by a `+` to the 
content URI (the name is specified as part of the tool configuration, see 
below).

Local content references can also use globbing to include multiple files:

```markdown
[Code](./src/**)
[Images](./images/*.jpg)
```

You can refer to the documentation for Bun's [Glob 
api](https://bun.sh/docs/api/glob) for the exact Glob syntax supported.

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

1. Send the current conversation to the LLM.
2. Instruct the LLM to summarize the conversation as a new memory.
3. Update the YAML header, inserting the new memory in the 
   `interlocutor.memories` field
4. Write the resulting YAML header to `conversation-tomorrow.lec`

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
summarize the conversation effectively. If a multiparty conversation is 
consolidated, each interlocutor will consolidate their own memories.

### Tools

Lectic allows you to configure tools that your LLM can use to perform different 
kinds of actions during your conversation.

<details>

<summary>

#### Command Execution Tool

</summary>

The exec tool allows the LLM to execute commands directly. For security, you can
configure which commands are available and optionally run them in a sandbox.

```yaml
tools:
    - exec: python3             # Allow LLM to run Python
      name: python              # Optional custom name
      usage: "Usage guide..."   # Instructions for the LLM
      sandbox: ./sandbox.sh     # Optional sandboxing script
      confirm: ./confirm.sh     # Optional confirmation script
```

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

##### Command Execution Safety

> [!WARNING]
> If you provide your LLM access to any dangerous commands, you should take 
> some safety precautions.

When an exec tool is configured with a sandbox script, the command and its 
arguments are passed to the sandbox script which is responsible for executing 
them in a controlled environment. For example, the provided 
`extra/sandbox/bwrap-sandbox.sh` uses 
[bubblewrap](https://github.com/containers/bubblewrap) to create a basic 
sandbox with a temporary home directory.

When an exec tool is configured with a confirm script, the confirm script will 
be executed before every call to that tool, with two arguments: the name of the 
tool, and a JSON string representing the arguments to the call. If the confirm 
script returns a nonzero exit status, the tool call is cancelled. An example 
confirmation script, using [zenity](https://github.com/GNOME/zenity) is 
included in this repository at `extra/confirm/zenity-confirm.sh`.

</details>

<details>

<summary>

#### SQLite Query Tool

</summary>

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

</details>

<details>

<summary>

#### Think Tool

</summary>

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

</details>

<details>

<summary>

#### Server Tool

</summary>

This tool lets you give your LLM access to a simple web server, so that it can 
serve you up web pages and apps that it generates, a bit like Claude's 
[artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them). 
and [analysis 
tool](https://support.anthropic.com/en/articles/10008684-enabling-and-using-the-analysis-tool). 
The web page should automatically open in your browser (the conversation will 
be blocked until the page is loaded). Once the page is loaded, the server will 
be shut down.

```yaml
tools:
    - serve_on_port: 9000   # serve on localhost:9000
      name: my_server       # Optional custom name
```

Example conversation using the think tool:

```markdown
Could you serve me up a little tic-tac-toe game?

:::Assistant


{server}
A WHOLE BUNCH OF HTML, JS, and CSS
{/server}

There you go! Your tic-tac-toe game is available on localhost:9000

:::
```

</details>

<details>

<summary>

#### MCP Tool

</summary>

Lectic lets you use [model context protocol](https://modelcontextprotocol.io) 
servers to provide tools for your LLMs. There are already a huge number of 
servers available: check out [this list 
](https://github.com/modelcontextprotocol/servers) provided by the MCP 
organization, and also [awesome MCP 
servers](https://github.com/punkpeye/awesome-mcp-servers). To provide access to 
an MCP server, you can add the server as a tool like this:

```yaml
tools:
    - mcp_command: npx # The main command to launch the server
      name: brave      # Optional name, used in resource content references (see above)
      roots:           # Optional list of filesystem roots
        - /home/graham/research-docs/
      args:            # Additional arguments to the main command
        - "-y"
        - "@modelcontextprotocol/server-brave-search"
      env:             # Environment for the server to run in.
        - BRAVE_API_KEY: YOUR_KEY_GOES_HERE
      confirm: ./confirm.sh # Optional confirmation script
      sandbox: ./sandbox.sh # Optional sandboxing script
    - mcp_sse: URL_GOES_HERE # URL for a remote MCP server that uses SSE
      confirm: ./confirm.sh
    - mcp_ws: URL_GOES_HERE # URL to a remote MCP server that uses Websockets
      confirm: ./confirm.sh
```

[Roots](https://modelcontextprotocol.io/specification/2025-03-26/client/roots#roots) 
are supported, and giving a server a name lets you retrieve any 
[resources](https://modelcontextprotocol.io/docs/concepts/resources#resources) 
that the server provides using content references. The LLM will also be 
provided with a tool that allows it to list resources that the server makes 
available.

Example conversation using the MCP tool:

```markdown
Could you do a brave web search for cool facts about ants?

:::Assistant

Sure!

{brave_search_tool}
query: cool ant facts
{/brave_search_tool}

Did you know that ants have two stomachs, one for themselves and one for food 
they're going to share with the colony?

:::
```

##### MCP Safety

> [!WARNING]
> By default, lectic grants LLMs full access to tools provided by MCP servers. 
> If you have a server that provides potentially dangerous tools, you should 
> take some safety precautions.
>
> Lectic's safety mechanisms are intended to protect you from an LLM making 
> mistakes. They offer only very limited defense against a genuinely malicious 
> MCP server. There are serious security risks associated with the MCP 
> protocol. You should never connect to an untrusted server. See 
> [this post](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/), for 
> examples and details.

When an local MCP tool is configured with a sandbox script, the command that 
starts the MCP server, along with its arguments are passed to the sandbox 
script which is responsible for executing them in a controlled environment. For 
example, the provided `extra/sandbox/bwrap-sandbox.sh` uses 
[bubblewrap](https://github.com/containers/bubblewrap) to create a basic 
sandbox with a temporary home directory.

When an MCP tool is configured with a confirm script, the confirm script will 
be executed before every call to that tool, with two arguments: the name of the 
tool, and a JSON string representing the arguments to the call. If the confirm 
script returns a nonzero exit status, the tool call is cancelled. An example 
confirmation script, using [zenity](https://github.com/GNOME/zenity) is 
included in this repository at `extra/confirm/zenity-confirm.sh`.

</details>

<details>

<summary>

#### Native Tools

</summary>

Native tools give you access to some of the built-in functionality 
that certain LLM backends provide, for example built in search or 
code execution environments. At the moment two kinds of native tools 
are supported: `search` and `code`. Native search lets the LLM 
perform web searches, and native code lets it execute code in a 
remote sandbox for data analysis tasks. You can provide access to 
native tools like this:

```yaml
tools:
    - native: search # provide a native search tool
    - native: code   # provide a native code sandbox tool
```

Native tool support varies by LLM provider. Right now, Lectic supports native 
tool use with gemini and anthropic.

- Recent gemini models support both search and code. But they're subject to 
  some limitations imposed by the Gemini API. You cannot provide more than one 
  native tool at a time, and you cannot combine native tools with other tools. 
  (If you try, the API will throw an error. If you find that it doesn't, Google 
  must have lifted this limitation—in that case, let me know!)
- Anthropic support search only. For more information, you can read [this 
  announcement](https://www.anthropic.com/news/web-search-api).

</details>

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

interlocutors:
    - ANOTHER_INTERLOCUTOR_HERE
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
lectic -h                                  # View help text
lectic -f conversation.lec                 # Generate a new message from a conversation file
lectic -l debug.log -f conversation.lec    # Write debug logs to debug.log
lectic -s -f convo.lec                     # Only return the new message
lectic -S -f convo.lec                     # Only return the new message, without speaker indications
lectic -c -f convo.lec                     # Consolidate a new set of memories 
lectic -i convo.lec                        # Update convo.lec in-place with the next message
lectic -v                                  # Get a version string
cat convo.lec | lectic                     # Read convo.lec from stdin
echo "hello"  | lectic -f convo.lec        # Add a message to convo.lec and get the result
```

## Contributing

Lectic is open to contributions. Areas of particular interest:
- Additional LLM backend support
- More Editor integrations
- New tool types
- Good lectic templates
- Documentation improvements
