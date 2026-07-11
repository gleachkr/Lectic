# Lectic memory plugin

Local durable memory and searchable, sanitized conversation history.

The plugin provides two related stores:

- **Memories** are selected, higher-level facts with a short gist and detailed
  content. They are explicitly managed by the assistant through a tool.
- **Conversation history** automatically records user and assistant prose so
  older discussions can be searched without promoting every message into
  durable memory.

On the first user message in a new conversation, the plugin injects a short
briefing containing the gists of the most recently updated applicable
memories.

## Install

### From this repository

```yaml
imports:
  - ./extra/plugins/lectic-memory/lectic.yaml

interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  tools:
    - kit: memory_kit
```

### As a discovered plugin

```bash
mkdir -p "$LECTIC_DATA/plugins/lectic-memory"
cp -r ./extra/plugins/lectic-memory/* \
  "$LECTIC_DATA/plugins/lectic-memory/"
chmod +x \
  "$LECTIC_DATA/plugins/lectic-memory/lectic-memory.ts" \
  "$LECTIC_DATA/plugins/lectic-memory/scripts/"*.sh
```

Then import and enable its tool kit:

```yaml
imports:
  - plugin: lectic-memory

interlocutor:
  name: Assistant
  prompt: You are a helpful assistant.
  tools:
    - kit: memory_kit
```

Importing `lectic.yaml` enables history capture and the first-message
briefing. Adding `memory_kit` gives the active interlocutor the memory tool.

## Commands

```bash
lectic memory add \
  --gist "This project uses Bun for scripts and tests." \
  --content "Use bun test. Do not substitute npm test." \
  --kind project-fact

lectic memory search "test command"
lectic memory get 1
lectic memory list
lectic memory update 1 --gist "Use Bun for all project scripts."
lectic memory forget 1
lectic memory history "why did the parser test fail"
lectic memory status
lectic memory doctor
```

The default scope is `project`. Use `--scope user` for stable preferences that
should follow the user across projects.

Supported kinds are:

- `preference`
- `decision`
- `project-fact`
- `procedure`
- `error-solution`
- `constraint`
- `other`

## Gists and briefings

Every durable memory has:

- `gist`: one or two concise sentences suitable for session startup
- `content`: supporting detail, evidence, paths, commands, and qualifications

The `user_first` hook injects up to ten recent active gists from user scope
and from the current project. It does not inject full memory content or raw
conversation history.

The briefing explicitly labels memories as historical notes rather than
instructions. Current instructions take precedence, and time-sensitive facts
must be checked again.

## Conversation history

The plugin records the current `USER_MESSAGE` on `user_message` and the prose
from each assistant pass on `assistant_message`.

Lectic's `ASSISTANT_MESSAGE` does not contain tool-call or thought blocks. The
plugin also strips serialized tool calls, thought blocks, and inline 
attachments defensively before storage.

History is searched explicitly:

```bash
lectic memory history "database migration discussion"
```

Search is limited to the current project unless `--all-projects` is passed.
Raw history is never included in the automatic briefing.

## Project identity

Project identity is resolved in this order:

1. `--project KEY`
2. `LECTIC_MEMORY_PROJECT`
3. a hash derived from the Git origin and repository name
4. a hash of the resolved working directory

Use `lectic memory status` to inspect the effective key. Set an explicit key
when multiple clones should share project memory or unrelated worktrees should
remain separate.

## Storage and privacy

The default database is:

```text
$LECTIC_DATA/memory/memory.sqlite3
```

Override it with `LECTIC_MEMORY_DB` or `--db PATH`.

Conversation history may contain sensitive personal or project information.
Treat the database like the original `.lec` files when setting permissions,
backing it up, or sharing it. Automatic history capture does not use a model
and does not make network requests.

`forget` is a soft deletion. Deleted memories are excluded from briefing and
search but retained for later audit or recovery. Physical purge and retention
policies are intentionally deferred until consolidation semantics are chosen.
