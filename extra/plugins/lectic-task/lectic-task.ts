#!/usr/bin/env -S lectic script

import "./schema.sql"

import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { createTaskWithEditor, editTaskWithEditor } from "./taskEditor.ts"
import { defaultDbPath, projectIdentity } from "./project.ts"
import type { ProjectIdentity } from "./project.ts"
import {
  ALL_PRIORITIES,
  ALL_STATUSES,
  PRIORITY_ORDER_SQL,
  TRANSITIONS,
  TaskError,
  addNote,
  archiveTask,
  attachArtifact,
  createTask,
  defaultActor,
  defaultSession,
  ensureTaskExists,
  isArtifactKind,
  isPriority,
  isStatus,
  likePattern,
  transitionTask,
} from "./taskCore.ts"
import type {
  Actor,
  ArtifactRow,
  NoteRow,
  Status,
  TaskEventRow,
  TaskRow,
} from "./taskCore.ts"

type CommandResponse = {
  ok: true
  command: string
  data: unknown
  warnings: string[]
}

type ErrorResponse = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

const CliError = TaskError
type CliError = TaskError

type ParsedGlobalArgs = {
  dbPath: string
  projectOverride?: string
  json: boolean
  help: boolean
  argv: string[]
}

type Context = {
  db: Database
  dbPath: string
  project: ProjectIdentity
}

type ParsedFlags = {
  positional: string[]
  values: Map<string, string[]>
  booleans: Set<string>
}


function usage(): string {
  return [
    "Usage:",
    "  lectic task [--db PATH] [--project KEY] <command> [args...] [--json]",
    "",
    "Commands:",
    "  create        Create a task",
    "  edit          Edit a task in $EDITOR",
    "  list          List tasks",
    "  show          Show task details",
    "  transition    Transition task status",
    "  note          Add a note",
    "  attach        Attach an artifact",
    "  next          Show next actionable task",
    "  archive       Archive a task",
    "  render-todo   Render markdown task list",
    "  status        Show storage and project information",
    "  doctor        Check database integrity",
    "  complete      Emit YAML completions for macro argument LSP",
    "",
    "",
    "Tasks are scoped to the current project (derived from the Git origin,",
    "or the working directory). Override with --project or",
    "LECTIC_TASK_PROJECT. Listing commands accept --all-projects.",
    "",
    "Run 'lectic task <command> --help' for command-specific options.",
  ].join("\n")
}

function commandUsage(command: string): string {
  switch (command) {
    case "create":
      return [
        "Usage:",
        "  lectic task create --title TEXT [options]",
        "  lectic task create --editor [options]",
        "",
        "Options:",
        "  --desc TEXT",
        "  --priority low|medium|high|critical",
        "  --effort HOURS",
        "  --parent ID",
        "  --editor",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "edit":
      return [
        "Usage:",
        "  lectic task edit <id> [options]",
        "",
        "Options:",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "list":
      return [
        "Usage:",
        "  lectic task list [options]",
        "",
        "Options:",
        "  --status STATUS[,STATUS...]",
        "  --priority PRIORITY[,PRIORITY...]",
        "  --query TEXT",
        "  --limit N",
        "  --offset N",
        "  --sort updated|created|priority",
        "  --all-projects",
      ].join("\n")
    case "show":
      return [
        "Usage:",
        "  lectic task show <id>",
      ].join("\n")
    case "transition":
      return [
        "Usage:",
        "  lectic task transition <id> <status> [options]",
        "",
        "Options:",
        "  --note TEXT",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "note":
      return [
        "Usage:",
        "  lectic task note <id> --text TEXT [options]",
        "",
        "Options:",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "attach":
      return [
        "Usage:",
        "  lectic task attach <id> --kind KIND --path PATH [options]",
        "",
        "Kinds:",
        "  report|plan|summary|code|doc|other",
        "",
        "Options:",
        "  --summary TEXT",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "next":
      return [
        "Usage:",
        "  lectic task next [--all-projects]",
      ].join("\n")
    case "archive":
      return [
        "Usage:",
        "  lectic task archive <id> [options]",
        "",
        "Options:",
        "  --actor TEXT",
        "  --session TEXT",
      ].join("\n")
    case "render-todo":
      return [
        "Usage:",
        "  lectic task render-todo [--out PATH] [--all-projects]",
      ].join("\n")
    case "status":
      return [
        "Usage:",
        "  lectic task status",
      ].join("\n")
    case "doctor":
      return [
        "Usage:",
        "  lectic task doctor",
      ].join("\n")
    case "complete":
      return [
        "Usage:",
        "  lectic task complete [options]",
        "",
        "Options:",
        "  --status STATUS[,STATUS...]",
        "  --limit N",
        "  --all-projects",
      ].join("\n")
    default:
      return usage()
  }
}

function parseGlobalArgs(rawArgv: string[]): ParsedGlobalArgs {
  const argv: string[] = []
  let dbPath = defaultDbPath()
  let projectOverride = process.env["LECTIC_TASK_PROJECT"]
  let json = false
  let help = false

  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]
    if (arg === "--db" || arg === "--project") {
      const value = rawArgv[i + 1]
      if (!value) {
        throw new CliError("INVALID_ARGUMENT", `missing value for ${arg}`)
      }
      if (arg === "--db") dbPath = value
      else projectOverride = value
      i++
      continue
    }

    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length)
      continue
    }

    if (arg.startsWith("--project=")) {
      projectOverride = arg.slice("--project=".length)
      continue
    }

    if (arg === "--json") {
      json = true
      continue
    }

    if (arg === "-h" || arg === "--help") {
      help = true
      argv.push("--help")
      continue
    }

    argv.push(arg)
  }

  return {
    dbPath: resolve(dbPath),
    projectOverride,
    json,
    help,
    argv,
  }
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = []
  const values = new Map<string, string[]>()
  const booleans = new Set<string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }

    if (arg === "--help" || arg === "-h") {
      booleans.add("help")
      continue
    }

    const eqIndex = arg.indexOf("=")
    if (eqIndex > 0) {
      const name = arg.slice(2, eqIndex)
      const value = arg.slice(eqIndex + 1)
      const list = values.get(name) ?? []
      list.push(value)
      values.set(name, list)
      continue
    }

    const name = arg.slice(2)
    const maybeValue = args[i + 1]
    if (!maybeValue || maybeValue.startsWith("--")) {
      booleans.add(name)
      continue
    }

    const list = values.get(name) ?? []
    list.push(maybeValue)
    values.set(name, list)
    i++
  }

  return {
    positional,
    values,
    booleans,
  }
}

function flagValue(parsed: ParsedFlags, name: string): string | undefined {
  const list = parsed.values.get(name)
  if (!list || list.length === 0) return undefined
  return list[list.length - 1]
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new CliError(
      "INVALID_ARGUMENT",
      `invalid number for --${flag}: ${raw}`,
    )
  }
  return n
}

function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError("INVALID_ARGUMENT", `invalid task id: ${raw}`)
  }
  return id
}

function parseCsv<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (raw === undefined) return undefined
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (entries.length === 0) {
    throw new CliError("INVALID_ARGUMENT", `empty value for --${field}`)
  }

  const allowedSet = new Set(allowed)
  const parsed: T[] = []
  for (const entry of entries) {
    if (!allowedSet.has(entry as T)) {
      throw new CliError(
        "INVALID_ARGUMENT",
        `invalid ${field} value: ${entry}`,
      )
    }
    parsed.push(entry as T)
  }

  return parsed
}

async function createDb(dbPath: string): Promise<Database> {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)

  const schemaPath = new URL("./schema.sql", import.meta.url)
  const schemaSql = await Bun.file(schemaPath).text()
  db.exec(schemaSql)
  db.exec("PRAGMA foreign_keys = ON")

  return db
}

// Listing commands are scoped to the current project unless --all-projects
// is passed. Id-addressed commands (show, transition, ...) are not scoped:
// ids are global, so a task can be referenced from anywhere.
function projectFilter(
  ctx: Context,
  parsed: ParsedFlags,
  where: string[],
  values: (string | number)[],
): boolean {
  if (parsed.booleans.has("all-projects")) return true
  where.push("project_key = ?")
  values.push(ctx.project.key)
  return false
}

function actorFromFlags(parsed: ParsedFlags): Actor {
  return {
    actor: flagValue(parsed, "actor") ?? defaultActor(),
    session: flagValue(parsed, "session") ?? defaultSession(),
  }
}

function toResponse(command: string, data: unknown, warnings: string[] = []): CommandResponse {
  return {
    ok: true,
    command,
    data,
    warnings,
  }
}

function toError(error: unknown): ErrorResponse {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message,
    },
  }
}

function humanList(tasks: TaskRow[], showProject = false): string {
  if (tasks.length === 0) {
    return "No tasks found."
  }

  return tasks
    .map((task) => {
      const effort = task.effort_hours === null ? "-" : `${task.effort_hours}h`
      const project = showProject ? ` {${task.project_key}}` : ""
      return `#${task.id} [${task.status}] (${task.priority}) ${task.title} [effort: ${effort}]${project}`
    })
    .join("\n")
}

function taskDetailsMarkdown(
  task: TaskRow,
  notes: NoteRow[],
  artifacts: ArtifactRow[],
  events: TaskEventRow[],
): string {
  const lines: string[] = []
  lines.push(`# Task #${task.id}: ${task.title}`)
  lines.push("")
  lines.push(`- Project: ${task.project_key}`)
  lines.push(`- Status: ${task.status}`)
  lines.push(`- Priority: ${task.priority}`)
  if (task.effort_hours !== null) {
    lines.push(`- Effort (hours): ${task.effort_hours}`)
  }
  if (task.parent_id !== null) {
    lines.push(`- Parent: #${task.parent_id}`)
  }
  lines.push(`- Created: ${task.created_at}`)
  lines.push(`- Updated: ${task.updated_at}`)
  if (task.started_at) lines.push(`- Started: ${task.started_at}`)
  if (task.completed_at) lines.push(`- Completed: ${task.completed_at}`)
  if (task.archived_at) lines.push(`- Archived: ${task.archived_at}`)
  lines.push("")
  lines.push("## Description")
  lines.push("")
  lines.push(task.description || "(empty)")
  lines.push("")

  lines.push("## Artifacts")
  if (artifacts.length === 0) {
    lines.push("")
    lines.push("(none)")
  } else {
    for (const artifact of artifacts) {
      lines.push("")
      lines.push(`- [${artifact.kind}] ${artifact.path}`)
      if (artifact.summary) {
        lines.push(`  - ${artifact.summary}`)
      }
    }
  }

  lines.push("")
  lines.push("## Notes")
  if (notes.length === 0) {
    lines.push("")
    lines.push("(none)")
  } else {
    for (const note of notes) {
      lines.push("")
      lines.push(`- ${note.created_at} (${note.actor}): ${note.note}`)
    }
  }

  lines.push("")
  lines.push("## Recent Events")
  if (events.length === 0) {
    lines.push("")
    lines.push("(none)")
  } else {
    for (const event of events) {
      const transition =
        event.from_status && event.to_status
          ? ` ${event.from_status} -> ${event.to_status}`
          : ""
      lines.push("")
      lines.push(`- ${event.created_at}: ${event.event}${transition}`)
    }
  }

  return lines.join("\n")
}

function renderTodo(tasks: TaskRow[]): string {
  const grouped = new Map<Status, TaskRow[]>()
  for (const status of ALL_STATUSES) {
    grouped.set(status, [])
  }

  for (const task of tasks) {
    const bucket = grouped.get(task.status)
    if (bucket) {
      bucket.push(task)
    }
  }

  const lines: string[] = []
  lines.push("# Tasks")
  lines.push("")

  for (const status of ALL_STATUSES) {
    const bucket = grouped.get(status) ?? []
    if (bucket.length === 0) continue

    lines.push(`## ${status}`)
    lines.push("")

    for (const task of bucket) {
      lines.push(`### ${task.id}. ${task.title}`)
      lines.push(`- **Status**: [${task.status.toUpperCase()}]`)
      lines.push(`- **Priority**: ${task.priority}`)
      if (task.effort_hours !== null) {
        lines.push(`- **Effort**: ${task.effort_hours}h`)
      }
      lines.push("")
      lines.push(`**Description**: ${task.description || "(empty)"}`)
      lines.push("")
    }
  }

  return lines.join("\n")
}

function toTaskRows(rows: unknown[]): TaskRow[] {
  return rows as TaskRow[]
}

function toArtifactRows(rows: unknown[]): ArtifactRow[] {
  return rows as ArtifactRow[]
}

function toNoteRows(rows: unknown[]): NoteRow[] {
  return rows as NoteRow[]
}

function toEventRows(rows: unknown[]): TaskEventRow[] {
  return rows as TaskEventRow[]
}

async function executeCreate(ctx: Context, args: string[]): Promise<CommandResponse> {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("create"))
  }

  const title = flagValue(parsed, "title")
  const desc = flagValue(parsed, "desc") ?? ""
  const priorityRaw = flagValue(parsed, "priority") ?? "medium"

  if (!isPriority(priorityRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid priority: ${priorityRaw}`)
  }

  const effort = parseNumber(flagValue(parsed, "effort"), "effort")
  const parentRaw = flagValue(parsed, "parent")
  const parentId = parentRaw ? parseId(parentRaw) : null
  const who = actorFromFlags(parsed)

  if (parsed.booleans.has("editor")) {
    try {
      const result = await createTaskWithEditor(db, {
        projectKey: ctx.project.key,
        who,
        source: "task-cli",
        initial: {
          title: title?.trim() ?? "",
          description: desc,
          priority: priorityRaw,
          effort_hours: effort ?? null,
          parent_id: parentId,
        },
      })

      return toResponse("create", {
        task: result.task,
        cancelled: result.cancelled,
        message: result.message,
      })
    } catch (error) {
      throw editorError(error)
    }
  }

  if (!title || title.trim().length === 0) {
    throw new CliError("INVALID_ARGUMENT", "--title is required")
  }

  const task = createTask(db, ctx.project.key, {
    title,
    description: desc,
    status: "not_started",
    priority: priorityRaw,
    effort_hours: effort ?? null,
    parent_id: parentId,
  }, who)

  return toResponse("create", { task, cancelled: false })
}

// The editor flow reports validation problems as plain Errors; keep core
// errors (with their codes) intact and wrap everything else.
function editorError(error: unknown): CliError {
  if (error instanceof TaskError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new CliError("INVALID_ARGUMENT", message)
}

async function executeEdit(db: Database, args: string[]): Promise<CommandResponse> {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("edit"))
  }

  const idRaw = parsed.positional[0]
  if (!idRaw) {
    throw new CliError("INVALID_ARGUMENT", "edit requires <id>")
  }

  const task = ensureTaskExists(db, parseId(idRaw))

  try {
    const result = await editTaskWithEditor(db, task, {
      who: actorFromFlags(parsed),
      source: "task-cli",
    })

    return toResponse("edit", {
      task: result.task,
      cancelled: result.cancelled,
      updated: result.changed,
      message: result.message,
    })
  } catch (error) {
    throw editorError(error)
  }
}

function executeList(ctx: Context, args: string[]): CommandResponse {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("list"))
  }

  const statuses = parseCsv(flagValue(parsed, "status"), ALL_STATUSES, "status")
  const priorities = parseCsv(
    flagValue(parsed, "priority"),
    ALL_PRIORITIES,
    "priority",
  )

  const query = flagValue(parsed, "query")
  const limit = parseNumber(flagValue(parsed, "limit"), "limit") ?? 50
  const offset = parseNumber(flagValue(parsed, "offset"), "offset") ?? 0
  const sort = flagValue(parsed, "sort") ?? "updated"

  if (limit <= 0 || limit > 500) {
    throw new CliError("INVALID_ARGUMENT", "--limit must be between 1 and 500")
  }
  if (offset < 0) {
    throw new CliError("INVALID_ARGUMENT", "--offset must be >= 0")
  }

  const where: string[] = ["archived_at IS NULL"]
  const values: (string | number)[] = []
  const allProjects = projectFilter(ctx, parsed, where, values)

  if (statuses && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`)
    values.push(...statuses)
  }

  if (priorities && priorities.length > 0) {
    where.push(`priority IN (${priorities.map(() => "?").join(",")})`)
    values.push(...priorities)
  }

  if (query && query.trim().length > 0) {
    where.push(
      `(title LIKE ? ESCAPE '\\'
        OR description LIKE ? ESCAPE '\\'
        OR CAST(id AS TEXT) LIKE ? ESCAPE '\\')`,
    )
    const like = likePattern(query.trim())
    values.push(like, like, like)
  }

  let orderBy = "updated_at DESC, id DESC"
  if (sort === "created") {
    orderBy = "created_at DESC, id DESC"
  } else if (sort === "priority") {
    orderBy = `${PRIORITY_ORDER_SQL} ASC, updated_at DESC, id DESC`
  } else if (sort !== "updated") {
    throw new CliError("INVALID_ARGUMENT", `invalid sort field: ${sort}`)
  }

  const sql = `
    SELECT *
    FROM tasks
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `

  values.push(limit, offset)

  const tasks = toTaskRows(db.query(sql).all(...values))
  return toResponse("list", {
    count: tasks.length,
    tasks,
    filters: {
      statuses,
      priorities,
      query: query ?? null,
      limit,
      offset,
      sort,
      all_projects: allProjects,
    },
  })
}

function executeShow(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("show"))
  }

  const idRaw = parsed.positional[0]
  if (!idRaw) {
    throw new CliError("INVALID_ARGUMENT", "show requires a task id")
  }

  const taskId = parseId(idRaw)
  const task = ensureTaskExists(db, taskId)

  const notes = toNoteRows(
    db
      .query("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId),
  )

  const artifacts = toArtifactRows(
    db
      .query("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId),
  )

  const events = toEventRows(
    db
      .query("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId),
  )

  return toResponse("show", {
    task,
    notes,
    artifacts,
    events,
  })
}

function executeTransition(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("transition"))
  }

  const idRaw = parsed.positional[0]
  const toStatusRaw = parsed.positional[1]
  if (!idRaw || !toStatusRaw) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "transition requires <id> and <status>",
    )
  }

  if (!isStatus(toStatusRaw)) {
    throw new CliError("INVALID_STATUS", `invalid status: ${toStatusRaw}`)
  }

  const note = flagValue(parsed, "note")?.trim() || null
  const current = ensureTaskExists(db, parseId(idRaw))
  const task = transitionTask(db, current, toStatusRaw, actorFromFlags(parsed), {
    note,
  })

  return toResponse("transition", {
    from: current.status,
    to: toStatusRaw,
    task,
    note,
  })
}

function executeNote(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("note"))
  }

  const idRaw = parsed.positional[0]
  if (!idRaw) {
    throw new CliError("INVALID_ARGUMENT", "note requires <id>")
  }

  const taskId = parseId(idRaw)
  const text = flagValue(parsed, "text")
  if (!text || text.trim().length === 0) {
    throw new CliError("INVALID_ARGUMENT", "--text is required")
  }

  const note = addNote(db, taskId, text, actorFromFlags(parsed))

  return toResponse("note", {
    task_id: taskId,
    note,
  })
}

function executeAttach(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("attach"))
  }

  const idRaw = parsed.positional[0]
  if (!idRaw) {
    throw new CliError("INVALID_ARGUMENT", "attach requires <id>")
  }

  const taskId = parseId(idRaw)
  const kindRaw = flagValue(parsed, "kind")
  const pathRaw = flagValue(parsed, "path")
  if (!kindRaw || !pathRaw) {
    throw new CliError("INVALID_ARGUMENT", "--kind and --path are required")
  }

  if (!isArtifactKind(kindRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid artifact kind: ${kindRaw}`)
  }

  const summary = flagValue(parsed, "summary") ?? ""
  attachArtifact(db, taskId, kindRaw, pathRaw, summary, actorFromFlags(parsed))

  return toResponse("attach", {
    task_id: taskId,
    kind: kindRaw,
    path: pathRaw,
    summary,
  })
}

function executeNext(ctx: Context, args: string[]): CommandResponse {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("next"))
  }

  const where = [
    "archived_at IS NULL",
    "status NOT IN ('completed', 'abandoned')",
  ]
  const values: (string | number)[] = []
  projectFilter(ctx, parsed, where, values)

  const nextTask = db
    .query(
      `SELECT *
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY
         ${PRIORITY_ORDER_SQL} ASC,
         CASE status
           WHEN 'implementing' THEN 0
           WHEN 'partial' THEN 1
           WHEN 'planned' THEN 2
           WHEN 'planning' THEN 3
           WHEN 'researching' THEN 4
           WHEN 'researched' THEN 5
           WHEN 'blocked' THEN 6
           WHEN 'not_started' THEN 7
           ELSE 8
         END ASC,
         updated_at ASC,
         id ASC
       LIMIT 1`
    )
    .get(...values) as TaskRow | null

  return toResponse("next", {
    task: nextTask,
  })
}

function executeArchive(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("archive"))
  }

  const idRaw = parsed.positional[0]
  if (!idRaw) {
    throw new CliError("INVALID_ARGUMENT", "archive requires <id>")
  }

  const task = ensureTaskExists(db, parseId(idRaw))
  const updated = archiveTask(db, task, actorFromFlags(parsed))
  return toResponse("archive", {
    task: updated,
  })
}

function executeRenderTodo(ctx: Context, args: string[]): CommandResponse {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("render-todo"))
  }

  const outPathRaw = flagValue(parsed, "out")
  const outPath = outPathRaw ? resolve(outPathRaw) : undefined

  const where: string[] = ["archived_at IS NULL"]
  const values: (string | number)[] = []
  projectFilter(ctx, parsed, where, values)

  const tasks = toTaskRows(
    db
      .query(
        `SELECT *
         FROM tasks
         WHERE ${where.join(" AND ")}
         ORDER BY ${PRIORITY_ORDER_SQL} ASC, updated_at DESC, id DESC`
      )
      .all(...values),
  )

  const markdown = renderTodo(tasks)
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, markdown, "utf8")
  }

  return toResponse("render-todo", {
    out_path: outPath ?? null,
    markdown,
  })
}

function yamlScalar(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n")}"`
}

function executeComplete(ctx: Context, args: string[]): CommandResponse {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("complete"))
  }

  const statuses = parseCsv(flagValue(parsed, "status"), ALL_STATUSES, "status")
  const limit = parseNumber(flagValue(parsed, "limit"), "limit") ?? 40

  if (limit <= 0 || limit > 200) {
    throw new CliError("INVALID_ARGUMENT", "--limit must be between 1 and 200")
  }

  const where: string[] = ["archived_at IS NULL"]
  const values: (string | number)[] = []
  projectFilter(ctx, parsed, where, values)

  if (statuses && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`)
    values.push(...statuses)
  }

  values.push(limit)

  const rows = toTaskRows(
    db
      .query(
        `SELECT id, title, status, priority, updated_at
         FROM tasks
         WHERE ${where.join(" AND ")}
         ORDER BY ${PRIORITY_ORDER_SQL} ASC, updated_at DESC
         LIMIT ?`
      )
      .all(...values),
  )

  const completions = rows.map((task) => ({
    completion: String(task.id),
    detail: `[${task.status}] ${task.priority}`,
    documentation: task.title,
  }))

  const yaml = completions
    .map((item) => [
      `- completion: ${yamlScalar(item.completion)}`,
      `  detail: ${yamlScalar(item.detail)}`,
      `  documentation: ${yamlScalar(item.documentation)}`,
    ].join("\n"))
    .join("\n")

  return toResponse("complete", {
    completions,
    yaml: yaml || "[]",
  })
}

function executeStatus(ctx: Context, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("status"))
  }

  const projectTasks = ctx.db
    .query(
      `SELECT count(*) AS count FROM tasks
       WHERE project_key = ? AND archived_at IS NULL`
    )
    .get(ctx.project.key) as { count: number }
  const allTasks = ctx.db
    .query("SELECT count(*) AS count FROM tasks WHERE archived_at IS NULL")
    .get() as { count: number }
  const projects = ctx.db
    .query("SELECT count(DISTINCT project_key) AS count FROM tasks")
    .get() as { count: number }

  return toResponse("status", {
    database: ctx.dbPath,
    project: ctx.project.label,
    project_key: ctx.project.key,
    project_key_source: ctx.project.source,
    project_tasks: projectTasks.count,
    total_tasks: allTasks.count,
    projects: projects.count,
  })
}

function executeDoctor(ctx: Context, args: string[]): CommandResponse {
  const { db } = ctx
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("doctor"))
  }

  const issues: string[] = []

  const requiredTables = ["tasks", "task_events", "artifacts", "task_notes"]
  const tableRows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .all() as Array<{ name: string }>

  const existing = new Set(tableRows.map((row) => row.name))
  for (const table of requiredTables) {
    if (!existing.has(table)) {
      issues.push(`missing table: ${table}`)
    }
  }

  const emptyProjectRows = db
    .query("SELECT id FROM tasks WHERE trim(project_key) = ''")
    .all() as Array<{ id: number }>

  for (const row of emptyProjectRows) {
    issues.push(`task #${row.id} has an empty project key`)
  }

  const invalidStatusRows = db
    .query(
      `SELECT id, status FROM tasks
       WHERE status NOT IN (${ALL_STATUSES.map(() => "?").join(",")})`
    )
    .all(...ALL_STATUSES) as Array<{ id: number; status: string }>

  for (const row of invalidStatusRows) {
    issues.push(`task #${row.id} has invalid status: ${row.status}`)
  }

  const invalidPriorityRows = db
    .query(
      `SELECT id, priority FROM tasks
       WHERE priority NOT IN (${ALL_PRIORITIES.map(() => "?").join(",")})`
    )
    .all(...ALL_PRIORITIES) as Array<{ id: number; priority: string }>

  for (const row of invalidPriorityRows) {
    issues.push(`task #${row.id} has invalid priority: ${row.priority}`)
  }

  const orphanArtifacts = db
    .query(
      `SELECT a.id, a.task_id
       FROM artifacts a
       LEFT JOIN tasks t ON t.id = a.task_id
       WHERE t.id IS NULL`
    )
    .all() as Array<{ id: number; task_id: number }>

  for (const row of orphanArtifacts) {
    issues.push(`artifact #${row.id} references missing task #${row.task_id}`)
  }

  const orphanNotes = db
    .query(
      `SELECT n.id, n.task_id
       FROM task_notes n
       LEFT JOIN tasks t ON t.id = n.task_id
       WHERE t.id IS NULL`
    )
    .all() as Array<{ id: number; task_id: number }>

  for (const row of orphanNotes) {
    issues.push(`note #${row.id} references missing task #${row.task_id}`)
  }

  const transitionEvents = db
    .query(
      `SELECT id, task_id, from_status, to_status
       FROM task_events
       WHERE event = 'transition'`
    )
    .all() as Array<{
      id: number
      task_id: number
      from_status: string | null
      to_status: string | null
    }>

  for (const row of transitionEvents) {
    if (!row.from_status || !row.to_status) {
      issues.push(`transition event #${row.id} missing from/to status`)
      continue
    }

    if (!isStatus(row.from_status) || !isStatus(row.to_status)) {
      issues.push(`transition event #${row.id} has invalid status value(s)`)
      continue
    }

    if (!TRANSITIONS[row.from_status].has(row.to_status)) {
      issues.push(
        `transition event #${row.id} has invalid transition ${row.from_status} -> ${row.to_status}`,
      )
    }
  }

  return toResponse("doctor", {
    healthy: issues.length === 0,
    issue_count: issues.length,
    issues,
  })
}

function printHuman(command: string, response: CommandResponse): void {
  const data = response.data as Record<string, unknown>

  switch (command) {
    case "create": {
      const task = data.task as TaskRow | null
      if (!task) {
        console.log(String(data.message ?? "Task creation cancelled."))
        return
      }
      console.log(`Created task #${task.id}: ${task.title}`)
      console.log(`Status: ${task.status}`)
      console.log(`Priority: ${task.priority}`)
      return
    }

    case "edit": {
      const task = data.task as TaskRow | null
      const updated = data.updated as boolean | undefined
      if (updated === false || !task) {
        console.log(String(data.message ?? "Task unchanged."))
        return
      }
      console.log(`Updated task #${task.id}: ${task.title}`)
      console.log(`Status: ${task.status}`)
      console.log(`Priority: ${task.priority}`)
      return
    }

    case "list": {
      const tasks = data.tasks as TaskRow[]
      const filters = data.filters as { all_projects: boolean }
      console.log(humanList(tasks, filters.all_projects))
      return
    }

    case "show": {
      const task = data.task as TaskRow
      const notes = data.notes as NoteRow[]
      const artifacts = data.artifacts as ArtifactRow[]
      const events = data.events as TaskEventRow[]
      console.log(taskDetailsMarkdown(task, notes, artifacts, events))
      return
    }

    case "transition": {
      const task = data.task as TaskRow
      const from = data.from as string
      const to = data.to as string
      const note = data.note as string | null
      console.log(`Task #${task.id}: ${from} -> ${to}`)
      if (note) {
        console.log(`Note: ${note}`)
      }
      return
    }

    case "note": {
      const taskId = data.task_id as number
      console.log(`Added note to task #${taskId}.`)
      return
    }

    case "attach": {
      const taskId = data.task_id as number
      const kind = data.kind as string
      const path = data.path as string
      console.log(`Attached ${kind} artifact to task #${taskId}: ${path}`)
      return
    }

    case "next": {
      const task = data.task as TaskRow | null
      if (!task) {
        console.log("No actionable tasks found.")
        return
      }
      console.log(`Next: #${task.id} [${task.status}] ${task.title}`)
      return
    }

    case "archive": {
      const task = data.task as TaskRow
      console.log(`Archived task #${task.id}: ${task.title}`)
      return
    }

    case "render-todo": {
      const outPath = data.out_path as string | null
      const markdown = data.markdown as string
      if (outPath) {
        console.log(`Wrote task markdown to: ${outPath}`)
      } else {
        console.log(markdown)
      }
      return
    }

    case "status": {
      console.log(`Database: ${String(data.database)}`)
      console.log(
        `Project: ${String(data.project)} [${String(data.project_key)}] (${String(data.project_key_source)})`,
      )
      console.log(`Active tasks in project: ${String(data.project_tasks)}`)
      console.log(
        `Active tasks total: ${String(data.total_tasks)} across ${String(data.projects)} project(s)`,
      )
      return
    }

    case "doctor": {
      const healthy = data.healthy as boolean
      const issues = data.issues as string[]
      if (healthy) {
        console.log("Doctor: healthy")
      } else {
        console.log(`Doctor: found ${issues.length} issue(s)`)
        for (const issue of issues) {
          console.log(`- ${issue}`)
        }
      }
      return
    }

    case "complete": {
      const yaml = data.yaml as string
      console.log(yaml)
      return
    }

    default:
      console.log(JSON.stringify(response, null, 2))
  }
}

async function dispatch(
  ctx: Context,
  command: string,
  args: string[],
): Promise<CommandResponse> {
  const { db } = ctx
  switch (command) {
    case "create":
      return executeCreate(ctx, args)
    case "edit":
      return executeEdit(db, args)
    case "list":
      return executeList(ctx, args)
    case "show":
      return executeShow(db, args)
    case "transition":
      return executeTransition(db, args)
    case "note":
      return executeNote(db, args)
    case "attach":
      return executeAttach(db, args)
    case "next":
      return executeNext(ctx, args)
    case "archive":
      return executeArchive(db, args)
    case "render-todo":
      return executeRenderTodo(ctx, args)
    case "status":
      return executeStatus(ctx, args)
    case "doctor":
      return executeDoctor(ctx, args)
    case "complete":
      return executeComplete(ctx, args)
    default:
      throw new CliError("INVALID_ARGUMENT", `unknown command: ${command}`)
  }
}

async function main(): Promise<void> {
  const parsedGlobal = parseGlobalArgs(process.argv.slice(2))

  if (parsedGlobal.argv.length === 0 || parsedGlobal.help) {
    const candidate = parsedGlobal.argv[0]
    if (candidate && candidate !== "--help" && candidate !== "-h") {
      console.log(commandUsage(candidate))
    } else {
      console.log(usage())
    }
    return
  }

  const command = parsedGlobal.argv[0]
  const rest = parsedGlobal.argv.slice(1)

  try {
    const ctx: Context = {
      db: await createDb(parsedGlobal.dbPath),
      dbPath: parsedGlobal.dbPath,
      project: projectIdentity(parsedGlobal.projectOverride),
    }
    const response = await dispatch(ctx, command, rest)

    if (parsedGlobal.json) {
      console.log(JSON.stringify(response, null, 2))
    } else {
      printHuman(command, response)
    }
  } catch (error) {
    const err = error instanceof CliError && error.code === "SHOW_HELP"
      ? new CliError("SHOW_HELP", error.message)
      : error

    if (err instanceof CliError && err.code === "SHOW_HELP") {
      console.log(err.message)
      return
    }

    const errorResponse = toError(err)
    if (parsedGlobal.json) {
      console.log(JSON.stringify(errorResponse, null, 2))
    } else {
      console.error(`${errorResponse.error.code}: ${errorResponse.error.message}`)
      if (errorResponse.error.details !== undefined) {
        console.error(JSON.stringify(errorResponse.error.details, null, 2))
      }
      const helpHint = commandUsage(command)
      if (helpHint !== usage()) {
        console.error("")
        console.error(helpHint)
      }
      process.exitCode = 1
    }
  }
}

await main()
