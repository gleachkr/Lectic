# Skills plugin (`lectic skills`)

This plugin provides the `lectic skills` subcommand for the
[Agent Skills](https://agentskills.io) format.

## Contents

- `lectic-skills.ts` - subcommand implementation
- `lectic-skills.test.ts` - regression tests for discovery and root selection

## Default discovery behavior

When you do not include `--`, the subcommand uses default roots and searches
recursively in:

1. `LECTIC_RUNTIME` entries (in order)
2. `LECTIC_DATA`

## Commands

```bash
# list
lectic skills list

# include discovery text in tool usage
lectic skills --prompt

# force zero explicit skill roots (runtime/data only)
lectic skills --
lectic skills -- activate serve

# activate by name
lectic skills activate serve

# read a reference file inside a skill
lectic skills read serve references/USAGE.md

# run a script inside scripts/
lectic skills run serve serve.ts --port 8080 --file ./page.html
```

## Root argument examples

### 1) One skill root

Pass a directory that directly contains `SKILL.md`.
Use `--` to separate roots from the command:

```bash
lectic skills ./extra/skills/serve -- list
lectic skills ./extra/skills/serve -- activate serve
```

### 2) A `skills` directory containing many skill roots

Pass a parent directory whose immediate children are skill directories:

```bash
lectic skills ./extra/skills -- list
lectic skills ./extra/skills -- activate ink-tui-subcommand
```

### 3) Mixed roots (runtime skill names + path roots)

Bare root arguments (for example `serve`) are matched against skill names
found in `LECTIC_RUNTIME`. Filesystem roots must be explicit paths (`./...`
or `/...`). This lets you mix runtime skills with custom paths.

```bash
lectic skills serve ./my-skills -- list
lectic skills serve ./extra/skills -- activate serve
```

If a bare root does not match a runtime skill name, the command errors.
Use an explicit path prefix when you mean a filesystem path.
