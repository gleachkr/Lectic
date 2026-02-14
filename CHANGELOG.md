# Changelog

All notable changes to Lectic are documented in this file.

The format is intentionally simple so GitHub Actions can extract the notes
for a tag and publish them on the corresponding GitHub Release.

## v0.0.2 - unreleased

### Added

- Structured output support via `interlocutor.output_schema`, including
  validation and backend support.
- Expanded JSON Schema support for structured outputs, plus a dedicated
  reference page and cookbook recipe.
- Top-level `imports` support for modular config, including recursive imports,
  optional imports, directory imports (`<dir>/lectic.yaml`), and cycle errors.
- `local:./...` and `local:../...` support for import paths, plus
  `file:local:...` forms in external prompt fields.
- Named reusable definitions for hooks, env maps, and sandboxes via
  `hook_defs`, `env_defs`, `sandbox_defs`, and `use:` references.
- New hook lifecycle events and aliases: `assistant_final`,
  `assistant_intermediate`, `tool_use_post`, `run_start`, `run_end`, and
  `error` (alias of failing `run_end`).
- Additional hook environment context, including run metadata, token usage,
  tool duration, and serialized tool success/error payloads.
- `init_sql` support for the SQLite tool to initialize missing databases.
- `MESSAGE_TEXT` in macro expansion environment variables.
- Programmable macro argument completions in the LSP via inline lists,
  `file:` sources, or `exec:` sources.

### Changed

- Release artifacts now use a stable `<tag>-<platform>-<arch>` naming
  scheme and include platform tarballs for package manager distribution.
- Provider naming: `chatgpt` is now `codex`.
- Custom subcommand discovery now searches `$LECTIC_CONFIG` and
  `$LECTIC_DATA` recursively before checking `$PATH`.
- Bash completion discovery now mirrors runtime subcommand resolution and
  loads adjacent `.completion.bash` files for discovered commands.
- Expanded docs for hooks, configuration imports, external prompt path
  handling, structured outputs, and custom subcommands.

### Fixed

- Header validation and LSP diagnostics for `use:` references on hooks,
  `sandbox`, and tool/interlocutor `sandbox` fields.
- Minor header validation and documentation link fixes.
- Added CI link checking and corrected link-check invocation flags.

## v0.0.1 - 2026-02-03

### Added

- A2A support:
  - `lectic a2a` server mode (JSON-RPC + SSE) exposing configured agents.
  - Monitoring endpoints for agents and tasks.
  - Optional bearer token auth and resubscribe support.
  - A2A client tool support, including `tasks/get` polling.
- Built-in directives: `:attach`, `:env`, `:fetch`, `:merge_yaml`, and
  `:temp_merge_yaml`.
- Recursive macros with `pre`/`post` phases for more advanced automation.
- `lectic run` subcommand plus bash completion.
- Global `sandbox` configuration key and improved Bubblewrap wrapper.

### Changed

- `lectic script` now bundles JS/TS/JSX/TSX scripts (with `https://` imports)
  and supports React TSX/JSX via bundling.
- MCP updates:
  - Streamable HTTP support includes custom headers and OAuth.
  - New `only` allowlist support for server tools.
  - Removed deprecated MCP transport code paths.
- Documentation overhaul, including expanded automation/tooling references and
  cookbook recipes.

### Removed / Deprecated

- Deprecated `:cmd` inline attachments in favor of `:attach`.
- Removed legacy A2A aliases/endpoints.

### Fixed

- Agent tool and backend stability fixes (including error handling).
- SQLite tool hardening and safety improvements.
- Macro/directive expansion edge cases.
- LSP correctness fixes (highlighting, completions, code actions).
