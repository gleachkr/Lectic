# Lectic Task Plugin

SQLite-backed task management for Lectic.

This plugin is a greenfield task system inspired by complex Claude Code
workflows, but with a simpler architecture:

- single source of truth in SQLite
- one mutation surface: `lectic task ...`
- shared backend for macros, agents, and UI
- optional Ink dashboard (`lectic taskboard`)

## Contents

- `lectic-task.ts` - `lectic task` subcommand
- `lectic-taskboard.tsx` - `lectic taskboard` subcommand (Ink UI)
- `schema.sql` - database schema
- `lectic.yaml` - optional macros + task kit

## Install

### Option A: install under `LECTIC_DATA`

```bash
mkdir -p "$LECTIC_DATA/plugins/lectic-task"
cp -r ./extra/plugins/lectic-task/* "$LECTIC_DATA/plugins/lectic-task/"
chmod +x "$LECTIC_DATA/plugins/lectic-task/lectic-task.ts"
chmod +x "$LECTIC_DATA/plugins/lectic-task/lectic-taskboard.tsx"
```

Then import the plugin config in your project or user config:

```yaml
imports:
  - $LECTIC_DATA/plugins/lectic-task/lectic.yaml
```

### Option B: use in-repo

If you run from this repo and have subcommand discovery configured for this
path, you can import directly:

```yaml
imports:
  - ./extra/plugins/lectic-task/lectic.yaml
```

## Commands

```bash
# create/list/show
lectic task create --title "Implement fuzzy finder" --lang meta --priority high
lectic task list
lectic task show 1

# state transitions
lectic task transition 1 researching
lectic task transition 1 planned
lectic task transition 1 implementing
lectic task transition 1 completed

# notes and artifacts
lectic task note 1 --text "Need to validate completion flow"
lectic task attach 1 --kind report --path specs/001/reports/research-001.md

# utility
lectic task next
lectic task archive 1
lectic task render-todo --out specs/TODO.md
lectic task doctor

# completion source for macros/LSP
lectic task complete --status planned,implementing
```

## Dashboard

Run the Ink dashboard:

```bash
lectic taskboard
```

Keys:

- `j/k` or arrows: move selection
- `x`: clear query
- `q`: quit
- type to fuzzy-filter
- `R`: researching
- `P`: planned
- `I`: implementing
- `C`: completed
- `B`: blocked
- `A`: abandoned
- `Ctrl-D`: archive selected task (completed/abandoned only)

it refreshes automatically when the DB changes

## Database location

Default:

- `$LECTIC_DATA/task.sqlite3`

Override:

- `LECTIC_TASK_DB=/path/to/task.sqlite3`
- `lectic task --db /path/to/task.sqlite3 ...`
- `lectic taskboard --db /path/to/task.sqlite3`
