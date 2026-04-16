# Editor bridge plugin (`lectic editor`)

This plugin provides the `lectic editor` subcommand.

It talks to the Lectic LSP's local editor bridge, which lets hooks,
CLI tools, and scripts send a small set of editor-facing requests through
an existing LSP connection.

Supported commands:

- `lectic editor progress begin`
- `lectic editor progress report`
- `lectic editor progress end`
- `lectic editor approve`
- `lectic editor pick`

## Install

Place this directory somewhere Lectic discovers subcommands, for example:

- under a directory listed in `LECTIC_RUNTIME`
- under `$LECTIC_DATA`
- somewhere on your `PATH`

For example:

```bash
mkdir -p "$LECTIC_DATA/plugins/editor"
cp ./extra/plugins/editor/lectic-editor.ts \
  "$LECTIC_DATA/plugins/editor/"
chmod +x "$LECTIC_DATA/plugins/editor/lectic-editor.ts"
```

## Examples

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
  --message "Tool: $TOOL_NAME\n\nArgs:\n$TOOL_ARGS";
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

## Discovery

If you do not pass `--socket`, the subcommand searches upward from:

1. the directory containing `LECTIC_FILE`, if set
2. otherwise the current working directory

At each directory it checks for a deterministic socket path derived from
that directory. This avoids the need for a separate metadata file.
