# Changelog

All notable changes to Lectic are documented in this file.

The format is intentionally simple so GitHub Actions can extract the notes
for a tag and publish them on the corresponding GitHub Release.

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
