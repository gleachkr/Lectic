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
  github:gleachkr/lectic` will install lectic from the latest git commit. 
- If you're not using nix, but you're using a Linux system (or WSL on windows), 
  you can download an app image from the 
  [releases](https://github.com/gleachkr/Lectic/releases), and place it 
  somewhere on your `$PATH`. 
- If you're on macOS, you can download a binary from the 
  [releases](https://github.com/gleachkr/Lectic/releases), and place it 
  somewhere on your `$PATH`.

### Basic Workflow

1. Create a new conversation file with a YAML header:

   ```yaml
   ---
   interlocutor:
       name: Assistant
       provider: anthropic
       #↑ could be openai, gemini, openrouter, ollama, openai/chat, or  
       # anthropic/bedrock
       prompt: Your base prompt here
       #↑ or file:my_prompt.txt, to read from a file.
   ---

   Your initial message here
   ``` 

   To use the remote providers , you'll need `ANTHROPIC_API_KEY`, 
   `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` set in your 
   environment, or have AWS credentials available for AWS bedrock. If the 
   provider field is omitted, the default provider will be based on the 
   alphabetically first API key defined in the your environment, ignoring AWS 
   credentials.

2. Use your text editor to interact with the LLM:
   - In Vim: Use `%!lectic` to update the conversation
   - In other editors: Set up a key binding or command to pipe the current file
     through `lectic`

3. Or, From the command line: `lectic -s -f conversation.lec` will stream the 
   next message to the console, and `lectic -i conversation.lec` will update 
   the lectic file in-place.

### Editor Integration

<details>
<summary>

#### Neovim

</summary>

A Neovim plugin is provided in `extra/lectic.nvim` that offers support for the 
`.lec` filetype, including syntax highlighting, streaming responses, folding of 
tool use blocks, keymaps, and commands for updating conversations, and 
elaborating model responses. For more details, check out the 
[README](https://github.com/gleachkr/Lectic/blob/main/extra/lectic.nvim/README.md)

</details>

<details>
<summary>

#### VSCode

</summary>

A VSCode plugin is provided in `extra/lectic.vscode` that offers support for 
the `.lec` filetype, including syntax highlighting, streaming responses, 
folding of tool use blocks, keymaps, and commands for updating conversations, 
and elaborating model responses. For more details, check out the 
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

### Configuration

Lectic allows for flexible configuration through a hierarchy of YAML files. 
This lets you set up global defaults, per-project settings, and 
conversation-specific overrides.

Configuration is merged in the following order of precedence (lower to higher):

1.  **Configuration Directory**: Lectic will first look for a configuration 
    file at `lectic/lectic.yaml` in the configuration directory on your system, 
    typically `.configuration/lectic/lectic.yaml` on Linux. This is a good 
    place to put your global, user-level configuration.

3.  **`--Include` (`-I`) Flag**: You can use the `--Include` (or `-I`) 
    command-line flag to specify a YAML file to include. This is useful for 
    project-specific configurations. This will override any settings from 
    `$LECTIC_CONFIG`.

4.  **Lectic File Header**: The YAML front matter in your `.lec` file always 
    has the final say, overriding any settings from the other three sources.

You can override the default locations for Lectic's directories by setting
the following environment variables:

- `$LECTIC_CONFIG`: Overrides the configuration directory path.
- `$LECTIC_DATA`: Overrides the data directory path.
- `$LECTIC_CACHE`: Overrides the cache directory path.
- `$LECTIC_STATE`: Overrides the state directory path.

These variables, along with `$LECTIC_TEMP` (which points to a temporary 
directory), are automatically passed into the environment of any subprocesses 
that Lectic spawns. This includes `exec` tools and any executables or scripts 
used for generating prompts or usage instructions. This ensures that scripts or 
nested `lectic` calls can easily access the same configuration and data context 
as the main process.

<details>

<summary>

#### Merging Logic

</summary>

When merging configurations, Lectic follows these rules:

-   **Objects**: Are merged recursively. If a key is present in multiple 
    sources, the value from the source with higher precedence is used.
-   **Arrays**: Are merged based on the `name` attribute of their elements. If 
    two objects in an array have the same `name`, they are merged. Otherwise, 
    the arrays are concatenated. This is particularly useful for managing lists 
    of tools and interlocutors.
-   **Other Values, or Type-Mismatched Values**: The value from the 
    highest-precedence source is used.

Here's an example of how you might use this feature. You could have a 
`~/.config/lectic/lectic.yaml` file with your default 
provider and model:

```yaml
interlocutors:
    - name: octOpus
      provider: anthropic
      model: claude-3-opus-20240229
```

Then, for a specific project, you could have a `project.yaml` file with a 
different model and a tool:

```yaml
interlocutor:
    name: Basho
    model: claude-3-haiku-20240307
    tools:
        - exec: bash
        - agent: octOpus
```

You would then run `lectic -I project.yaml -f conversation.lec`, and Basho 
would be able to process converation.lec, calling octOpus as an agent as 
necessary (or you could switch interlocutors with `:ask[octOpus]`).

Finally, if your `conversation.lec` file has its own header, those settings 
will be applied on top of everything else.

</details>

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

`:aside[NAME]` works similarly, but only for one round, so your next message 
will be directed to your original interlocutor.

### Content References

Include local or remote content in conversations:

```markdown
[Local Document](./notes.pdf)
[Remote documentation](https://context7.com/d3/d3/llms.txt)
[Remote Paper](https://arxiv.org/pdf/2201.12345.pdf)
[Web Image](https://example.com/diagram.png)
[S3 Bucket](s3://my_bucket/dataset.csv)
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
  for Gemini. OpenAI requires an audio model, and only supports this via the 
  legacy chat interface, so you'll need `provider: openai/chat` rather than 
  `provider: openai`)

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

#### URI-Specific Features

While Lectic supports simple file paths for local content, you can also
use full URIs to unlock advanced features. This is particularly useful for
creating portable conversation files and for targeting specific parts of a
document.

When you reference a local file using the `file://` scheme, you can take
advantage of the following features.

**1. Environment Variable Expansion**

Lectic can expand environment variables in content reference URIs. This
includes `file://`, `http(s)://`, `s3://`, and MCP resource URIs. Use the
`$VAR_NAME` syntax; the curly bracket form (`${VAR_NAME}`) is not supported.
Environment variables are expanded within file URIs before globbing.

Since `file://` URIs must be absolute, you can use a variable like `$CWD`
or `$PWD` to construct an absolute path from the current directory:

[A local PDF](file://$PWD/papers/some_paper.pdf#page=2)
[My dataset](file://$DATA_ROOT/my_project/data.csv)

This makes your `.lec` files more flexible. The variable expansion also
works for `file:` and `exec:` URIs in your YAML configuration.

**2. Precise PDF Referencing**

For PDF documents, you can include a specific page or range of pages by
adding a fragment identifier to the URI. This tells the LLM to focus only
on the specified content.

-   **Reference a single page:**
    [Remote paper](https://arxiv.org/pdf/2201.12345.pdf#page=5)

-   **Reference a range of pages:**
    [Chapter 3](file:///path/to/book.pdf#pages=45-60)

Page numbering starts at 1, and ranges are inclusive (e.g., `#pages=5-10`
includes both page 5 and page 10). If you supply both `page` and
`pages` in the fragment, `pages` will take precedence. If the page or
range is malformed or out of bounds, Lectic will surface an error which
will be visible to the LLM.

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

### Macros

Lectic supports a simple but powerful macro system that allows you to
define and reuse snippets of text. This is useful for saving frequently
used prompts, automating repetitive workflows, and composing complex,
multi-step commands.

Macros are defined in your YAML configuration (either in the `.lec` file
header or in an included configuration file).

```yaml
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

To use a macro, you invoke it using a directive in your message:

```markdown
This was a long and productive discussion. Could you wrap it up?

:macro[summarize]
```

When Lectic processes the file, it will replace `:macro[summarize]` with the
full text from the `expansion` field before sending it to the LLM. This
expansion happens before any other directives (like `:cmd`) are executed.

Like the `prompt` field, the `expansion` can also load from a file or from the 
output of an executable or an inline script, `file:` or `exec:` prefixes.

### Tools

Lectic allows you to configure tools that your LLM can use to perform different 
kinds of actions during your conversation. Tool call actions occur in parallel, 
rather than serially. So for example, if your LLM uses the agent tool to 
dispatch ten queries to ten agents, then those ten agents all get to work at 
the same time, rather than each one only starting once the previous one has 
completed. 

<details>

<summary>

#### Command Execution Tool

</summary>

The exec tool allows the LLM to execute commands directly. The `exec`
field can be either a simple command or a multi-line script. For
security, you can configure which commands are available and optionally
run them in a sandbox.

```yaml
tools:
    - exec: python3             # Allow LLM to run Python
      name: python              # Optional custom name
      usage: "Usage guide..."   # Instructions for the LLM
      sandbox: ./sandbox.sh     # Optional sandboxing script
      confirm: ./confirm.sh     # Optional confirmation script
      env:                      # Optional additional environment variables
        FOO: BAR
```

For more complex tasks, you can provide an inline script directly in the
YAML configuration. This is particularly useful for creating custom
tools that are specific to your project or workflow. Lectic will
automatically detect that the `exec` field contains a script, and will
execute it accordingly.

```yaml
tools:
    - exec: |
        #!/bin/bash
        # A simple script to count the number of lines in a file
        wc -l $1
      name: line_counter
      usage: "Counts the lines in a file. Takes one argument: the path to the file."
```

When an inline script is executed, Lectic writes it to a temporary file
and then runs it. The first line of the script must be a shebang (e.g.,
`#!/bin/bash`) to specify the interpreter.

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
sandbox with a temporary home directory. More sandboxing scripts are available 
under `extra/sandbox`.

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
about something, in the style suggested by [Anthropic's engineering
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

Example conversation using the server tool:

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

#### Agent Tool

</summary>

You can use this tool to give an interlocutor the ability to query another 
interlocutor as an "agent". The second interlocutor will receive the query from 
the first, with nothing else in its context. Its reply will be returned as the 
tool output.

```yaml
interlocutors:
    - name: Kirk
      tools:
        - agent: Spock # The name of the agent to be called. Should be another interlocutor
          usage: Ask Spock for help when you're in trouble # Optional usage advice
          name: communicator # Optional name for the tool
    - name: Spock
      tools: 
        - think_about: how to bail out Kirk
        - exec: phaser
```

For some suggestions and usage guidelines on how to use agents, you might enjoy 
reading [this blog 
post](https://www.anthropic.com/engineering/built-multi-agent-research-system) 
from Anthropic.

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

When a local MCP tool is configured with a sandbox script, the command that 
starts the MCP server, along with its arguments are passed to the sandbox 
script which is responsible for executing them in a controlled environment. For 
example, the provided `extra/sandbox/bwrap-sandbox.sh` uses 
[bubblewrap](https://github.com/containers/bubblewrap) to create a basic 
sandbox with a temporary home directory. More sandboxing scripts are available 
under `extra/`.

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
tool use with Gemini, Anthropic, and OpenAI.

- Recent Gemini models support both search and code. But they're subject to 
  some limitations imposed by the Gemini API. You cannot provide more than one 
  native tool at a time, and you cannot combine native tools with other tools. 
  (If you try, the API will throw an error. If you find that it doesn't, Google 
  must have lifted this limitation—in that case, let me know!)
- Anthropic support search only. For more information, you can read [this 
  announcement](https://www.anthropic.com/news/web-search-api).
- OpenAI provides native search and code through the new responses API. So 
  you'll need to use the `openai` provider, rather than the legacy 
  `openai/chat` provider.

</details>

## Configuration Reference

```yaml
interlocutor:
    # Required fields
    name: Assistant              # Name shown in responses
    prompt: Base prompt          # Core personality/instruction
    # prompt: file:./prompt.txt
    # ↑ the Prompt can be provided as a file path
    # prompt: exec:sqlite3 prompt.db "SELECT prompt FROM prompts LIMIT 1"
    # ↑ the prompt can also provided as a command with arguments

    # Optional model configuration
    provider: anthropic         # Optional, default anthropic
    model: claude-3-7-sonnet    # Model selection
    temperature: 0.7            # Response variability (0-1)
    max_tokens: 1024            # Maximum response length
    max_tool_use: 10            # Maximum permitted tool calls 

    # Optional Context management
    reminder: Be nice.          # Reminder string, added to 
                                # user message invisibly.
                                
    # Tool integration
    tools:
        # Command execution tool
        - exec: python3         # Command to execute
          name: python          # Optional custom name
          usage: "Usage: ..."   # String, `file:` or `exec:` for usage guide

        # Database tool
        - sqlite: data.db       # Database file
          name: query           # Optional custom name
          limit: 10000          # Max result size
          details: schema.txt   # String, `file:` or `exec:` for database details

interlocutors:
    - ANOTHER_INTERLOCUTOR_HERE

# Macro definitions
macros:
    - name: my_macro              # The name used in :macro[my_macro]
      expansion: "Text..."       # String, `file:`, or `exec:` source for the macro
```

## Command Line Interface
```bash
lectic -h                                  # View help text
lectic -f conversation.lec                 # Generate a new message from a conversation file
lectic -l debug.log -f conversation.lec    # Write debug logs to debug.log
lectic -s -f convo.lec                     # Only return the new message
lectic -S -f convo.lec                     # Only return the new message, without speaker indications
lectic -i convo.lec                        # Update convo.lec in-place with the next message
lectic -I project.yaml -f convo.lec        # Include a project-specific config
lectic -Hf convo.lec                       # Print just the header of the lectic
                                           # (use -Hi to reset a lectic, erasing all messages)
lectic -v                                  # Get a version string
cat convo.lec | lectic                     # Read convo.lec from stdin
echo "hello"  | lectic -Si convo.lec        # Add a message to convo.lec and get the result
```

## Contributing

Lectic is open to contributions. Areas of particular interest:
- Additional LLM backend support
- More Editor integrations
- New tool types
- Good lectic templates
- Documentation improvements
