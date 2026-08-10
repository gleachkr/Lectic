# Lectic goal plugin

Persistent goals with explicit completion and session handoffs.

The plugin creates one YAML goal file per interlocutor. An inline final hook
keeps an unfinished goal active, allows a completed goal to end normally, and
resets context from a persisted handoff briefing when a fresh session should
continue.

## Install

From this repository:

```yaml
imports:
  - ./extra/plugins/lectic-goal/lectic.yaml

interlocutor:
  name: Assistant
  prompt: You are a coding assistant.
  tools:
    - kit: goal_kit
```

As a discovered plugin:

```yaml
imports:
  - plugin: lectic-goal

interlocutor:
  name: Assistant
  prompt: You are a coding assistant.
  tools:
    - kit: goal_kit
```

Importing the plugin enables the `:goal[]` macro and lifecycle hooks. Adding
`goal_kit` gives the interlocutor the tools needed to finish or hand off the
goal.

## Start a goal

```markdown
:goal[
Implement authenticated project exports, including tests and documentation.
]
```

This creates `Assistant.goal` beside the active `.lec` file. If Lectic is not
using a file, the goal is created in the current working directory.

Set `LECTIC_GOAL_DIR` to override the directory.

The macro refuses to replace an unfinished goal. The CLI supports an explicit
forced replacement:

```bash
lectic goal set --goal "Replacement goal" --force
```

## Agent workflow

The kit exposes two tools:

- `goal_handoff` requires a standalone `BRIEFING` for a successor.
- `goal_complete` requires a `SUMMARY` of the outcome and verification.

The handoff tool persists its briefing before changing the goal to
`ready_for_handoff`. On the following final assistant pass, the final hook
emits a `LECTIC:reset` prompt containing the goal and briefing. Reset content
replaces the outgoing response in provider context, so the successor continues
with the goal active again.

A briefing should include:

- work completed
- decisions and constraints
- files changed
- checks run and their results
- unresolved problems and risks
- the next concrete action

The handoff must be the outgoing session's final tool call. Further changes
would make the persisted briefing stale.

When the goal is complete, the final hook emits nothing and the conversation
ends normally.

## Goal file

The YAML file is the state machine's source of truth:

```yaml
version: 1
revision: 3
interlocutor: Assistant
status: active
goal: "Implement authenticated project exports."
created_at: 2026-08-14T10:00:00.000Z
updated_at: 2026-08-14T11:22:00.000Z
handoff_count: 1
latest_handoff:
  number: 1
  created_at: 2026-08-14T11:22:00.000Z
  session_id: 019...
  briefing: "Exports work. Add the integration test next."
completion: null
```

States are:

- `active`
- `ready_for_handoff`
- `complete`

Writes use a temporary sibling file and atomic rename, so an interrupted write
cannot leave a partial YAML document.

## Recovery

The `user_first` hook injects an existing active goal into a fresh
conversation. If a process stopped after recording a handoff but before the
final hook reset context, the first-message hook consumes the ready handoff
and injects its briefing.

A completed goal is not injected. Starting a new goal may replace it.

## Commands

```bash
lectic goal set --goal "Implement exports"
lectic goal show
lectic goal show --json
lectic goal handoff --briefing "Tests pass; write docs next."
lectic goal complete --summary "Exports, tests, and docs are complete."
lectic goal resume
lectic goal final
lectic goal clear
lectic goal clear --force
```

`resume`, `reset`, and `final` are primarily hook-facing commands. They
remain public so the lifecycle can be inspected and tested without invoking a
model.

## Limits

Hook-induced passes still count toward Lectic's conversation-loop limit. A
handoff uses less overhead because its briefing is part of the transition tool
call, but a session already near its tool limit may leave little budget for
the successor.

After three final-hook reminders without a state transition, the plugin pauses
automatic continuation. The goal remains active and can resume on the next
turn. This avoids an unbounded token-consuming loop.
