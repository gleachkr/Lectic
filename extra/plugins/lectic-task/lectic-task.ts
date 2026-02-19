#!/usr/bin/env -S lectic script

import "./schema.sql"

import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

type Status =
  | "not_started"
  | "researching"
  | "researched"
  | "planning"
  | "planned"
  | "implementing"
  | "completed"
  | "partial"
  | "blocked"
  | "abandoned"

type Language =
  | "general"
  | "neovim"
  | "latex"
  | "typst"
  | "meta"
  | "markdown"

type Priority = "low" | "medium" | "high" | "critical"

type ArtifactKind = "report" | "plan" | "summary" | "code" | "doc" | "other"

type TaskRow = {
  id: number
  title: string
  description: string
  status: Status
  language: Language
  priority: Priority
  effort_hours: number | null
  parent_id: number | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
}

type TaskEventRow = {
  id: number
  task_id: number
  event: string
  from_status: string | null
  to_status: string | null
  actor: string
  session_id: string | null
  payload_json: string
  created_at: string
}

type ArtifactRow = {
  id: number
  task_id: number
  kind: string
  path: string
  summary: string
  created_at: string
}

type NoteRow = {
  id: number
  task_id: number
  note: string
  actor: string
  session_id: string | null
  created_at: string
}

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

class CliError extends Error {
  code: string
  details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

type ParsedGlobalArgs = {
  dbPath: string
  json: boolean
  help: boolean
  argv: string[]
}

type ParsedFlags = {
  positional: string[]
  values: Map<string, string[]>
  booleans: Set<string>
}

const ALL_STATUSES: readonly Status[] = [
  "not_started",
  "researching",
  "researched",
  "planning",
  "planned",
  "implementing",
  "completed",
  "partial",
  "blocked",
  "abandoned",
] as const

const ALL_LANGUAGES: readonly Language[] = [
  "general",
  "neovim",
  "latex",
  "typst",
  "meta",
  "markdown",
] as const

const ALL_PRIORITIES: readonly Priority[] = [
  "low",
  "medium",
  "high",
  "critical",
] as const

const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "report",
  "plan",
  "summary",
  "code",
  "doc",
  "other",
] as const

const TRANSITIONS: Record<Status, Set<Status>> = {
  not_started: new Set(["researching", "planning", "abandoned", "blocked"]),
  researching: new Set(["researched", "partial", "blocked", "abandoned"]),
  researched: new Set(["planning", "implementing", "abandoned", "blocked"]),
  planning: new Set(["planned", "partial", "blocked", "abandoned"]),
  planned: new Set(["implementing", "partial", "blocked", "abandoned"]),
  implementing: new Set(["completed", "partial", "blocked", "abandoned"]),
  partial: new Set([
    "researching",
    "planning",
    "implementing",
    "blocked",
    "abandoned",
  ]),
  blocked: new Set([
    "not_started",
    "researching",
    "planning",
    "implementing",
    "abandoned",
  ]),
  completed: new Set(),
  abandoned: new Set(),
}


function usage(): string {
  return [
    "Usage:",
    "  lectic task [--db PATH] <command> [args...] [--json]",
    "",
    "Commands:",
    "  create        Create a task",
    "  list          List tasks",
    "  show          Show task details",
    "  transition    Transition task status",
    "  note          Add a note",
    "  attach        Attach an artifact",
    "  next          Show next actionable task",
    "  archive       Archive a task",
    "  render-todo   Render markdown task list",
    "  doctor        Check database integrity",
    "  complete      Emit YAML completions for macro argument LSP",
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
        "",
        "Options:",
        "  --desc TEXT",
        "  --lang general|neovim|latex|typst|meta|markdown",
        "  --priority low|medium|high|critical",
        "  --effort HOURS",
        "  --parent ID",
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
        "  --lang LANG[,LANG...]",
        "  --priority PRIORITY[,PRIORITY...]",
        "  --query TEXT",
        "  --limit N",
        "  --offset N",
        "  --sort updated|created|priority",
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
        "  lectic task next [--lang LANG]",
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
        "  lectic task render-todo [--out PATH]",
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
        "  --lang LANG[,LANG...]",
        "  --limit N",
      ].join("\n")
    default:
      return usage()
  }
}

function parseGlobalArgs(rawArgv: string[]): ParsedGlobalArgs {
  const argv: string[] = []
  let dbPath = process.env["LECTIC_TASK_DB"]
  let json = false
  let help = false

  const defaultData = process.env["LECTIC_DATA"]
    ?? `${process.env["HOME"] ?? "."}/.local/share/lectic`

  dbPath ??= `${defaultData}/task.sqlite3`

  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]
    if (arg === "--db") {
      const value = rawArgv[i + 1]
      if (!value) {
        throw new CliError("INVALID_ARGUMENT", "missing value for --db")
      }
      dbPath = value
      i++
      continue
    }

    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length)
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

function isStatus(value: string): value is Status {
  return (ALL_STATUSES as readonly string[]).includes(value)
}

function nowIso(): string {
  return new Date().toISOString()
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

function defaultActor(): string {
  return process.env["LECTIC_INTERLOCUTOR"]
    ?? process.env["USER"]
    ?? process.env["USERNAME"]
    ?? "assistant"
}

function defaultSession(): string | undefined {
  return process.env["RUN_ID"]
    ?? process.env["LECTIC_SESSION"]
    ?? undefined
}

function ensureTaskExists(db: Database, taskId: number): TaskRow {
  const task = db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as TaskRow | null

  if (!task) {
    throw new CliError("TASK_NOT_FOUND", `task not found: ${taskId}`)
  }

  return task
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

function humanList(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return "No tasks found."
  }

  return tasks
    .map((task) => {
      const effort = task.effort_hours === null ? "-" : `${task.effort_hours}h`
      return `#${task.id} [${task.status}] (${task.priority}/${task.language}) ${task.title} [effort: ${effort}]`
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
  lines.push(`- Status: ${task.status}`)
  lines.push(`- Language: ${task.language}`)
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
  lines.push(`_Generated: ${nowIso()}_`)
  lines.push("")

  for (const status of ALL_STATUSES) {
    const bucket = grouped.get(status) ?? []
    if (bucket.length === 0) continue

    lines.push(`## ${status}`)
    lines.push("")

    for (const task of bucket) {
      lines.push(`### ${task.id}. ${task.title}`)
      lines.push(`- **Status**: [${task.status.toUpperCase()}]`)
      lines.push(`- **Language**: ${task.language}`)
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

function checkTransition(fromStatus: Status, toStatus: Status): void {
  if (fromStatus === toStatus) {
    throw new CliError(
      "INVALID_TRANSITION",
      `task is already in status '${toStatus}'`,
    )
  }

  const allowed = TRANSITIONS[fromStatus]
  if (!allowed.has(toStatus)) {
    throw new CliError(
      "INVALID_TRANSITION",
      `cannot transition ${fromStatus} -> ${toStatus}`,
    )
  }
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

function executeCreate(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("create"))
  }

  const title = flagValue(parsed, "title")
  if (!title || title.trim().length === 0) {
    throw new CliError("INVALID_ARGUMENT", "--title is required")
  }

  const desc = flagValue(parsed, "desc") ?? ""

  const langRaw = flagValue(parsed, "lang") ?? "general"
  const priorityRaw = flagValue(parsed, "priority") ?? "medium"

  if (!(ALL_LANGUAGES as readonly string[]).includes(langRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid language: ${langRaw}`)
  }
  if (!(ALL_PRIORITIES as readonly string[]).includes(priorityRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid priority: ${priorityRaw}`)
  }

  const effort = parseNumber(flagValue(parsed, "effort"), "effort")
  const parentRaw = flagValue(parsed, "parent")
  const parentId = parentRaw ? parseId(parentRaw) : undefined

  const actor = flagValue(parsed, "actor") ?? defaultActor()
  const session = flagValue(parsed, "session") ?? defaultSession()

  const createdAt = nowIso()
  let createdTask: TaskRow | null = null

  const tx = db.transaction(() => {
    if (parentId !== undefined) {
      ensureTaskExists(db, parentId)
    }

    const insertResult = db
      .query(
        `INSERT INTO tasks (
          title, description, status, language, priority,
          effort_hours, parent_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title.trim(),
        desc,
        "not_started",
        langRaw,
        priorityRaw,
        effort ?? null,
        parentId ?? null,
        createdAt,
        createdAt,
      )

    const taskId = Number(insertResult.lastInsertRowid)

    db
      .query(
        `INSERT INTO task_events (
          task_id, event, from_status, to_status, actor,
          session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        "created",
        null,
        "not_started",
        actor,
        session ?? null,
        JSON.stringify({
          title: title.trim(),
          language: langRaw,
          priority: priorityRaw,
        }),
        createdAt,
      )

    createdTask = ensureTaskExists(db, taskId)
  })

  tx()

  if (!createdTask) {
    throw new CliError("DB_ERROR", "failed to create task")
  }

  return toResponse("create", { task: createdTask })
}

function executeList(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("list"))
  }

  const statuses = parseCsv(flagValue(parsed, "status"), ALL_STATUSES, "status")
  const languages = parseCsv(flagValue(parsed, "lang"), ALL_LANGUAGES, "lang")
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

  if (statuses && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`)
    values.push(...statuses)
  }

  if (languages && languages.length > 0) {
    where.push(`language IN (${languages.map(() => "?").join(",")})`)
    values.push(...languages)
  }

  if (priorities && priorities.length > 0) {
    where.push(`priority IN (${priorities.map(() => "?").join(",")})`)
    values.push(...priorities)
  }

  if (query && query.trim().length > 0) {
    where.push("(title LIKE ? OR description LIKE ? OR CAST(id AS TEXT) LIKE ?)")
    const like = `%${query.trim()}%`
    values.push(like, like, like)
  }

  let orderBy = "updated_at DESC, id DESC"
  if (sort === "created") {
    orderBy = "created_at DESC, id DESC"
  } else if (sort === "priority") {
    orderBy = `
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END ASC,
      updated_at DESC,
      id DESC
    `
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
      languages,
      priorities,
      query: query ?? null,
      limit,
      offset,
      sort,
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

  const taskId = parseId(idRaw)
  if (!isStatus(toStatusRaw)) {
    throw new CliError("INVALID_STATUS", `invalid status: ${toStatusRaw}`)
  }
  const toStatus = toStatusRaw

  const note = flagValue(parsed, "note")
  const actor = flagValue(parsed, "actor") ?? defaultActor()
  const session = flagValue(parsed, "session") ?? defaultSession()

  const current = ensureTaskExists(db, taskId)
  if (current.archived_at) {
    throw new CliError("NOT_ALLOWED", "cannot transition an archived task")
  }

  checkTransition(current.status, toStatus)

  const updatedAt = nowIso()
  const shouldStart =
    toStatus === "researching"
    || toStatus === "planning"
    || toStatus === "implementing"

  const startedAt = current.started_at ?? (shouldStart ? updatedAt : null)
  const completedAt = toStatus === "completed" ? updatedAt : current.completed_at

  let updatedTask: TaskRow | null = null

  const tx = db.transaction(() => {
    db
      .query(
        `UPDATE tasks
         SET status = ?,
             updated_at = ?,
             started_at = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(toStatus, updatedAt, startedAt, completedAt, taskId)

    db
      .query(
        `INSERT INTO task_events (
          task_id, event, from_status, to_status, actor,
          session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        "transition",
        current.status,
        toStatus,
        actor,
        session ?? null,
        JSON.stringify({ note: note ?? null }),
        updatedAt,
      )

    if (note && note.trim().length > 0) {
      db
        .query(
          `INSERT INTO task_notes (
            task_id, note, actor, session_id, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(taskId, note.trim(), actor, session ?? null, updatedAt)
    }

    updatedTask = ensureTaskExists(db, taskId)
  })

  tx()

  if (!updatedTask) {
    throw new CliError("DB_ERROR", "failed to transition task")
  }

  return toResponse("transition", {
    from: current.status,
    to: toStatus,
    task: updatedTask,
    note: note ?? null,
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

  const actor = flagValue(parsed, "actor") ?? defaultActor()
  const session = flagValue(parsed, "session") ?? defaultSession()
  const createdAt = nowIso()

  ensureTaskExists(db, taskId)

  db
    .query(
      `INSERT INTO task_notes (
        task_id, note, actor, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, text.trim(), actor, session ?? null, createdAt)

  db
    .query(
      `INSERT INTO task_events (
        task_id, event, from_status, to_status, actor,
        session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      "noted",
      null,
      null,
      actor,
      session ?? null,
      JSON.stringify({ note: text.trim() }),
      createdAt,
    )

  return toResponse("note", {
    task_id: taskId,
    note: text.trim(),
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

  if (!(ALL_ARTIFACT_KINDS as readonly string[]).includes(kindRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid artifact kind: ${kindRaw}`)
  }

  const summary = flagValue(parsed, "summary") ?? ""
  const actor = flagValue(parsed, "actor") ?? defaultActor()
  const session = flagValue(parsed, "session") ?? defaultSession()
  const createdAt = nowIso()

  ensureTaskExists(db, taskId)

  db
    .query(
      `INSERT INTO artifacts (
        task_id, kind, path, summary, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, kindRaw, pathRaw, summary, createdAt)

  db
    .query(
      `INSERT INTO task_events (
        task_id, event, from_status, to_status, actor,
        session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      "artifact_attached",
      null,
      null,
      actor,
      session ?? null,
      JSON.stringify({ kind: kindRaw, path: pathRaw }),
      createdAt,
    )

  return toResponse("attach", {
    task_id: taskId,
    kind: kindRaw,
    path: pathRaw,
    summary,
  })
}

function executeNext(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("next"))
  }

  const langRaw = flagValue(parsed, "lang")
  if (langRaw && !(ALL_LANGUAGES as readonly string[]).includes(langRaw)) {
    throw new CliError("INVALID_ARGUMENT", `invalid language: ${langRaw}`)
  }

  const where = [
    "archived_at IS NULL",
    "status NOT IN ('completed', 'abandoned')",
  ]
  const values: string[] = []

  if (langRaw) {
    where.push("language = ?")
    values.push(langRaw)
  }

  const nextTask = db
    .query(
      `SELECT *
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           ELSE 3
         END ASC,
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

  const taskId = parseId(idRaw)
  const actor = flagValue(parsed, "actor") ?? defaultActor()
  const session = flagValue(parsed, "session") ?? defaultSession()
  const archivedAt = nowIso()

  const task = ensureTaskExists(db, taskId)
  if (task.archived_at !== null) {
    throw new CliError("NOT_ALLOWED", `task ${taskId} is already archived`)
  }

  db
    .query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(archivedAt, archivedAt, taskId)

  db
    .query(
      `INSERT INTO task_events (
        task_id, event, from_status, to_status, actor,
        session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      "archived",
      task.status,
      task.status,
      actor,
      session ?? null,
      JSON.stringify({ archived_at: archivedAt }),
      archivedAt,
    )

  const updated = ensureTaskExists(db, taskId)
  return toResponse("archive", {
    task: updated,
  })
}

function executeRenderTodo(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("render-todo"))
  }

  const outPathRaw = flagValue(parsed, "out")
  const outPath = outPathRaw ? resolve(outPathRaw) : undefined

  const tasks = toTaskRows(
    db
      .query(
        `SELECT *
         FROM tasks
         WHERE archived_at IS NULL
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             ELSE 3
           END ASC,
           updated_at DESC,
           id DESC`
      )
      .all(),
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

function executeComplete(db: Database, args: string[]): CommandResponse {
  const parsed = parseFlags(args)
  if (parsed.booleans.has("help")) {
    throw new CliError("SHOW_HELP", commandUsage("complete"))
  }

  const statuses = parseCsv(flagValue(parsed, "status"), ALL_STATUSES, "status")
  const languages = parseCsv(flagValue(parsed, "lang"), ALL_LANGUAGES, "lang")
  const limit = parseNumber(flagValue(parsed, "limit"), "limit") ?? 40

  if (limit <= 0 || limit > 200) {
    throw new CliError("INVALID_ARGUMENT", "--limit must be between 1 and 200")
  }

  const where: string[] = ["archived_at IS NULL"]
  const values: (string | number)[] = []

  if (statuses && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`)
    values.push(...statuses)
  }

  if (languages && languages.length > 0) {
    where.push(`language IN (${languages.map(() => "?").join(",")})`)
    values.push(...languages)
  }

  values.push(limit)

  const rows = toTaskRows(
    db
      .query(
        `SELECT id, title, status, language, priority, updated_at
         FROM tasks
         WHERE ${where.join(" AND ")}
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             ELSE 3
           END ASC,
           updated_at DESC
         LIMIT ?`
      )
      .all(...values),
  )

  const completions = rows.map((task) => ({
    completion: String(task.id),
    detail: `[${task.status}] ${task.priority}/${task.language}`,
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

function executeDoctor(db: Database, args: string[]): CommandResponse {
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

  const invalidStatusRows = db
    .query(
      `SELECT id, status FROM tasks
       WHERE status NOT IN (${ALL_STATUSES.map(() => "?").join(",")})`
    )
    .all(...ALL_STATUSES) as Array<{ id: number; status: string }>

  for (const row of invalidStatusRows) {
    issues.push(`task #${row.id} has invalid status: ${row.status}`)
  }

  const invalidLanguageRows = db
    .query(
      `SELECT id, language FROM tasks
       WHERE language NOT IN (${ALL_LANGUAGES.map(() => "?").join(",")})`
    )
    .all(...ALL_LANGUAGES) as Array<{ id: number; language: string }>

  for (const row of invalidLanguageRows) {
    issues.push(`task #${row.id} has invalid language: ${row.language}`)
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
      const task = data.task as TaskRow
      console.log(`Created task #${task.id}: ${task.title}`)
      console.log(`Status: ${task.status}`)
      console.log(`Language: ${task.language}`)
      console.log(`Priority: ${task.priority}`)
      return
    }

    case "list": {
      const tasks = data.tasks as TaskRow[]
      console.log(humanList(tasks))
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

function dispatch(db: Database, command: string, args: string[]): CommandResponse {
  switch (command) {
    case "create":
      return executeCreate(db, args)
    case "list":
      return executeList(db, args)
    case "show":
      return executeShow(db, args)
    case "transition":
      return executeTransition(db, args)
    case "note":
      return executeNote(db, args)
    case "attach":
      return executeAttach(db, args)
    case "next":
      return executeNext(db, args)
    case "archive":
      return executeArchive(db, args)
    case "render-todo":
      return executeRenderTodo(db, args)
    case "doctor":
      return executeDoctor(db, args)
    case "complete":
      return executeComplete(db, args)
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
    const db = await createDb(parsedGlobal.dbPath)
    const response = dispatch(db, command, rest)

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
