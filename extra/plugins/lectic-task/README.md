# Lectic Task Plugin

SQLite-backed task management for Lectic.

This plugin is a greenfield task system inspired by complex Claude Code
workflows, but with a simpler architecture:

- single source of truth in one SQLite database, scoped per project
- one mutation surface: `lectic task ...`
- shared backend for macros, agents, and UI
- optional Ink dashboard (`lectic taskboard`)

## Contents

- `lectic-task.ts` - `lectic task` subcommand
- `lectic-taskboard.tsx` - `lectic taskboard` subcommand (Ink UI)
- `taskCore.ts` - domain model, state machine, and mutations shared by the
  CLI, editor, and taskboard
- `project.ts` - project identity resolution (shared with `lectic-memory`)
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
  - plugin: lectic-task
```

This searches `LECTIC_RUNTIME`, `LECTIC_CONFIG`, and `LECTIC_DATA`
recursively for a directory named `lectic-task` containing `lectic.yaml`.

### Option B: use in-repo

If you run from this repo and have not installed the plugin into a Lectic
runtime/config/data root, import it by path:

```yaml
imports:
  - ./extra/plugins/lectic-task/lectic.yaml
```

## Commands

```bash
# create/list/show
lectic task create --title "Implement fuzzy finder" --priority high
lectic task create --editor
lectic task edit 1
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
lectic task status
lectic task doctor

# see tasks from every project, not just this one
lectic task list --all-projects

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
- `c`: create a task in `$EDITOR`
- `e`: edit the selected task in `$EDITOR`
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

The editor file uses header fields for title, status, priority, effort, and
parent id. Everything after the first blank line is treated as
the task description.

## Projects

All tasks live in one database, and each task is tagged with the project it
was created in. Listing commands (`list`, `next`, `complete`, `render-todo`,
and the taskboard) show only the current project's tasks unless
`--all-projects` is passed. Task ids are global, so id-addressed commands
(`show`, `transition`, `note`, `attach`, `edit`, `archive`) work on any task
regardless of project.

Project identity is resolved the same way as in `lectic-memory`:

1. `--project KEY`
2. `LECTIC_TASK_PROJECT`
3. a hash derived from the Git origin and repository name
4. a hash of the resolved working directory

Use `lectic task status` to inspect the effective key. The taskboard header
and `status` output also show a readable label (the repository or directory
name); the label is for display only and is never stored. Set an explicit key when
multiple clones should share a task list, or when unrelated directories under
one repository should be kept separate. Since the kit tools and macros in
`lectic.yaml` invoke `lectic task` as a subprocess, a per-interlocutor `env`
entry for `LECTIC_TASK_PROJECT` scopes that interlocutor's tasks.

## Database location

Default:

- `$LECTIC_DATA/task/task.sqlite3`

Override:

- `LECTIC_TASK_DB=/path/to/task.sqlite3`
- `lectic task --db /path/to/task.sqlite3 ...`
- `lectic taskboard --db /path/to/task.sqlite3`
