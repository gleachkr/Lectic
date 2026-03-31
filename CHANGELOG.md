# Changelog

All notable changes to Lectic are documented in this file.

The format is intentionally simple so GitHub Actions can extract the notes
for a tag and publish them on the corresponding GitHub Release.

## v0.0.3 - 2026-03-31

### Added

- Native "thinking" support for Anthropic and Gemini models, including
  Anthropic adaptive thinking plus configurable `thinking_effort` and
  `thinking_budget` settings.
- Serialized thought blocks in conversation logs with LSP hover and folding
  support.
- Configurable icons for tools, hooks, and inline attachments, which are
  preserved in the XML and displayed in editor UIs.
- `limit` field for `exec` tools to cap the total characters returned from
  stdout and stderr.
- New `install.sh` script for streamlined installation and automated
  `install-test` coverage in CI.
- New `lectic-task` plugin at `extra/plugins/lectic-task` providing a
  task-board TUI and persistent task tracking.
- Migrated `lectic-skills` to a plugin at `extra/plugins/skills` and added
  new built-in skills for local serving and TUI checklists.
- Support for `icon` and `name` attributes on `:attach` and `:hook`
  directives to control UI presentation.
- Autocomplete and diagnostics for `use:` references in the YAML header.
- `user_first` hook alias for running hooks before the first user message.
- `prompt` override field for `exec` tools.
- Support for loading `output_schema` from external files via `file:` paths.
- Edit/create via editor functionality in the task plugin.
- Plugin loading from `LECTIC_RUNTIME` directories.
- Configurable labels for autocomplete entries.

### Changed

- Non-zero hook exits now abort the current run by default unless
  `allow_failure: true` is set.
- Consolidated CLI output controls around `--format`; legacy `-s`, `-S`,
  and `-q` remain as deprecated aliases.
- Updated context compaction recipe and documentation to reflect recent
  pattern improvements.
- Improved tool-calling stability and signature handling for Gemini models.
- Refined timeout error messages to be less redundant.
- `extra/tab_complete` now handles subcommand discovery more robustly.
- Exec tools now always return the exit code.
- More flexible schemas for exec tool parameters.
- Bumped default models.
- Performance improvements for Neovim syntax highlighting.
- Performance improvements for LSP on long lectics.
- Improved spacing in streamed output.
- Better sanitization of user and assistant messages.

### Fixed

- Gemini tool calling signatures for complex parameter sets.
- `lectic parse` flag handling and reconstruction correctness.
- Restored `-i`/`--inplace` as a boolean flag so `lectic -if <file>` and
  `lectic -i -f <file>` work correctly.
- LSP folding and symbols for large configuration headers.
- Cursor positioning in `lectic.nvim`.
- Reversed boilerplate flag.

### Removed

- Legacy `think` tool.

## v0.0.2 - 2026-02-14

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
- `LECTIC_RUNTIME` environment variable to override recursive custom
  subcommand discovery roots.
- Experimental Nix sandbox plugin at `extra/plugins/nix-sandbox`.

### Changed

- Release artifacts now use a stable `<tag>-<platform>-<arch>` naming
  scheme and include platform tarballs for package manager distribution.
- Subcommand discovery now follows symlinks.
- Release pipeline now publishes `SHA256SUMS` and supports optional
  CI-driven Homebrew and AUR publishing.
- Linux tarball artifacts are built with Bun on Ubuntu runners and
  validated with an `ldd` dependency sanity check.
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
