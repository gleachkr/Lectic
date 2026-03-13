# Lectic TODO plugin

A small macro plugin for pulling TODOs from your current project into the
conversation.

It provides one macro:

- `:todo[]`

## What it does

- uses `rg` in the current working directory to find TODOs
- respects `.gitignore`
- skips a few common heavyweight directories even if they are not ignored
- inserts a short `path:line` completion value instead of the full TODO line
- shows the matched line inline in the completion menu
- includes a little surrounding context in completion detail/documentation
- adds a 2 second timeout around the `rg` scan
- offers TODO matches as macro argument completions
- expands the selected TODO into a fenced code block with nearby context,
  filename, and line range

## Install

### Option A: import from this repo

```yaml
imports:
  - ./extra/plugins/lectic-todo/lectic.yaml
```

### Option B: install under `LECTIC_DATA`

```bash
mkdir -p "$LECTIC_DATA/plugins/lectic-todo"
cp -r ./extra/plugins/lectic-todo/* "$LECTIC_DATA/plugins/lectic-todo/"
```

Then import it:

```yaml
imports:
  - $LECTIC_DATA/plugins/lectic-todo/lectic.yaml
```

## Usage

Invoke completion inside the macro argument position:

```markdown
:todo[]
```

In the LSP this is usually a manual completion invocation, because the
completion source runs `rg` and is intentionally marked `manual`.

Selecting a completion inserts a short `path:line` reference while still
showing the matched TODO line in the completion menu. Expansion later looks
like:

````markdown
TODO from `src/app.ts` lines 2-4 (TODO at line 3):

```ts
const middle = start + 1;
// TODO: validate the middle value
const end = middle + 1;
```
````

## Tuning

The macro definition sets these defaults, and you can override them with macro
attributes if you want:

- `TODO_MAX_RESULTS` - default `200`
- `TODO_CONTEXT` - default `3`
- `TODO_COMPLETION_CONTEXT` - default `2`
- `TODO_RG_TIMEOUT_SECONDS` - default `2`
- `TODO_PATTERN` - default `\bTODO\b`

Examples:

```markdown
:todo[]{TODO_CONTEXT="4"}
:todo[]{TODO_COMPLETION_CONTEXT="2"}
:todo[]{TODO_MAX_RESULTS="50"}
```