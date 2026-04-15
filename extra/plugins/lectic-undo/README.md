# Lectic undo plugin

Git-backed protection against agent edits.

This plugin captures a hidden git snapshot at the start of each user turn.
If the assistant leaves the repository changed by the end of the run, the
plugin records a transcript comment with the `lectic undo restore ...`
command needed to put the repo back.

The snapshots are stored as real commits under hidden refs:

```text
refs/lectic/undo/<id>/worktree
refs/lectic/undo/<id>/index
```

That means you can inspect them with ordinary git tooling, including
`git show` and third-party tools like Fugitive.

## What gets captured

- tracked file contents from the working tree
- untracked but unignored files
- tracked deletions
- executable bits and symlinks
- staged index state when `git write-tree` succeeds

Ignored files are intentionally left alone.

## Install

### Option A: import from this repo

```yaml
imports:
  - ./extra/plugins/lectic-undo/lectic.yaml
```

### Option B: install under `LECTIC_DATA`

```bash
mkdir -p "$LECTIC_DATA/plugins/lectic-undo"
cp -r ./extra/plugins/lectic-undo/* "$LECTIC_DATA/plugins/lectic-undo/"
chmod +x "$LECTIC_DATA/plugins/lectic-undo/lectic-undo.ts"
```

The adjacent `lectic-undo.completion.bash` file is picked up by Lectic's
bash completion loader automatically when the plugin is installed.

Then import it:

```yaml
imports:
  - plugin: lectic-undo
```

## Hook behavior

The bundled plugin config enables two hooks:

- `user_message` → `lectic undo capture`
- `assistant_final` → `lectic undo note`

`undo note` is recorded with `inline_as: comment`, so it does not get sent to
the model and it does not trigger another assistant pass.

## Commands

Plain `lectic undo` prints the latest saved worktree ref, so you can do:

```bash
git diff "$(lectic undo)"
```

`lectic undo diff <id>` compares the saved worktree snapshot against the
current worktree state. `--index` compares staged state instead.

```bash
lectic undo
lectic undo list
lectic undo show <id>
lectic undo diff <id>
lectic undo diff <id> --index
lectic undo restore <id>
lectic undo restore <id> --worktree-only
lectic undo restore <id> --index-only
lectic undo prune --keep-last 20
```

## Notes and limits

- This is scoped to the current git repository.
- Snapshots are keyed to the current Lectic file and interlocutor when the
  plugin tracks the pending snapshot for the current run.
- If a run makes no repo changes, the pending snapshot is deleted instead of
  being kept.
- Ignored files are not restored, and ignored files can still block a restore
  if they occupy paths that the snapshot needs.
- Submodules are not handled specially.
- If the index is conflicted and `git write-tree` fails, the snapshot will be
  worktree-only.
