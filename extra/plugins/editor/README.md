# Editor bridge plugin (`lectic editor`)

This plugin provides the `lectic editor` subcommand, reusable hook
definitions, and specialized hook scripts built on the same shared bridge
library.

It talks to the Lectic LSP's local editor bridge, which lets hooks,
CLI tools, and scripts send a small set of editor-facing requests through
an existing LSP connection.

Supported commands:

- `lectic editor progress begin`
- `lectic editor progress report`
- `lectic editor progress end`
- `lectic editor approve`
- `lectic editor pick`

Bundled hook definitions in `lectic.yaml`:

- `editor_tool_progress_start`
- `editor_tool_progress_end`
- `editor_run_progress_start`
- `editor_run_progress_end`
- `editor_approve_tools`

## Install

Place this directory somewhere Lectic discovers plugins, for example:

- under a directory listed in `LECTIC_RUNTIME`
- under `$LECTIC_DATA`
- somewhere on your `PATH`

Copy the whole directory, not just `lectic-editor.ts`, because the hooks and
shared library live alongside it.

For example:

```bash
mkdir -p "$LECTIC_DATA/plugins"
cp -R ./extra/plugins/editor "$LECTIC_DATA/plugins/"
chmod +x "$LECTIC_DATA/plugins/editor/lectic-editor.ts"
chmod +x "$LECTIC_DATA/plugins/editor/scripts/"*.ts
```

## Examples

Import the bundled hook definitions:

```yaml
imports:
  - plugin: editor
```

Then opt in to the hooks you want:

```yaml
hooks:
  - { use: editor_run_progress_start }
  - { use: editor_run_progress_end }
  - { use: editor_tool_progress_start }
  - { use: editor_tool_progress_end }
```

Or require editor approval for tool use:

```yaml
hooks:
  - { use: editor_approve_tools }
```

The hook scripts render tool arguments into short editor-friendly summaries.
For example, `{ "argv": ["git", "diff", "--cached"] }` becomes:

```text
git diff --cached
```

Progress:

```bash
TOKEN="${RUN_ID:-lectic-progress}"
lectic editor progress begin \
  --token "$TOKEN" \
  --title "Running checks" \
  --message "eslint"

lectic editor progress report \
  --token "$TOKEN" \
  --message "tsc" \
  --percentage 50

lectic editor progress end \
  --token "$TOKEN" \
  --message "Done"
```

Approval:

```bash
if lectic editor approve \
  --title "Allow tool use?" \
  --message "Tool: shell\n\nArguments:\ngit diff --cached";
then
  exit 0
else
  exit 1
fi
```

Pick from a list:

```bash
choice=$(lectic editor pick \
  --title "Choose deployment target" \
  --option staging \
  --option production)
```

The bundled progress hooks use `TOOL_CALL_ID` so parallel tool calls get
separate progress tokens. All progress hooks run in the background so they
do not hold up the main run. The bridge tolerates an `end` that arrives
before `begin`, which avoids stuck notifications when hook delivery is
out of order.

When Lectic is launched from `extra/lectic.nvim`, that plugin exports
Neovim's RPC server address in `NVIM`. The bundled `tool_use_post` hook
uses that to ask the parent Neovim to run `:checktime`, so buffers notice
external file changes promptly after tool calls finish.

They also format tool arguments into compact, polished summaries instead of
forwarding raw JSON blobs.

If you do not pass `--socket`, the subcommand searches upward from:

1. the directory containing `LECTIC_FILE`, if set
2. otherwise the current working directory

At each directory it checks for a deterministic socket path derived from
that directory. This avoids the need for a separate metadata file.
