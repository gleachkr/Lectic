import type { Database } from "bun:sqlite"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type Status =
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

export type Language =
  | "general"
  | "neovim"
  | "latex"
  | "typst"
  | "meta"
  | "markdown"

export type Priority = "low" | "medium" | "high" | "critical"

export type TaskLike = {
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

export type TaskEditorDraft = {
  title: string
  description: string
  status: Status
  language: Language
  priority: Priority
  effort_hours: number | null
  parent_id: number | null
}

export type EditorMutationResult<T extends TaskLike> = {
  changed: boolean
  cancelled: boolean
  message: string
  task: T | null
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

const STARTABLE_STATUSES: ReadonlySet<Status> = new Set([
  "researching",
  "planning",
  "implementing",
])

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

const HEADER_NAMES = new Map<string, keyof TaskEditorDraft>([
  ["title", "title"],
  ["status", "status"],
  ["language", "language"],
  ["priority", "priority"],
  ["effort-hours", "effort_hours"],
  ["parent-id", "parent_id"],
])

function parseCommandToArgv(command: string): string[] {
  const unquote = (part: string) =>
    (part.startsWith('"') && part.endsWith('"'))
    || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part

  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) ?? []
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[ _]+/g, "-")
}

function isStatus(value: string): value is Status {
  return (ALL_STATUSES as readonly string[]).includes(value)
}

function isLanguage(value: string): value is Language {
  return (ALL_LANGUAGES as readonly string[]).includes(value)
}

function isPriority(value: string): value is Priority {
  return (ALL_PRIORITIES as readonly string[]).includes(value)
}

function ensureTaskExists(db: Database, taskId: number): TaskLike {
  const task = db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as TaskLike | null

  if (!task) {
    throw new Error(`task not found: ${taskId}`)
  }

  return task
}

function checkTransition(fromStatus: Status, toStatus: Status): void {
  if (fromStatus === toStatus) {
    return
  }

  const allowed = TRANSITIONS[fromStatus]
  if (!allowed.has(toStatus)) {
    throw new Error(`cannot transition ${fromStatus} -> ${toStatus}`)
  }
}

function taskToDraft(task: TaskLike): TaskEditorDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    language: task.language,
    priority: task.priority,
    effort_hours: task.effort_hours,
    parent_id: task.parent_id,
  }
}

function renderValue(value: number | null): string {
  return value === null ? "" : String(value)
}

function renderTaskEditorDocument(
  mode: "create" | "edit",
  draft: TaskEditorDraft,
  taskId?: number,
): string {
  const heading = mode === "create"
    ? "# Create task"
    : `# Edit task #${taskId ?? "?"}`

  return [
    heading,
    "# Save and close your editor to apply these changes.",
    "# The description begins after the first blank line.",
    `# Allowed status values: ${ALL_STATUSES.join(", ")}`,
    `# Allowed language values: ${ALL_LANGUAGES.join(", ")}`,
    `# Allowed priority values: ${ALL_PRIORITIES.join(", ")}`,
    `Title: ${draft.title}`,
    `Status: ${draft.status}`,
    `Language: ${draft.language}`,
    `Priority: ${draft.priority}`,
    `Effort-Hours: ${renderValue(draft.effort_hours)}`,
    `Parent-Id: ${renderValue(draft.parent_id)}`,
    "",
    normalizeText(draft.description),
    "",
  ].join("\n")
}

function parseOptionalNumber(
  value: string,
  field: "Effort-Hours" | "Parent-Id",
): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${field}: ${value}`)
  }

  if (field === "Parent-Id") {
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`invalid ${field}: ${value}`)
    }
  } else if (parsed < 0) {
    throw new Error(`invalid ${field}: ${value}`)
  }

  return parsed
}

function parseTaskEditorDocument(content: string): TaskEditorDraft {
  const normalized = normalizeText(content)
  const lines = normalized.split("\n")
  const headerValues = new Map<keyof TaskEditorDraft, string>()
  let bodyStart = lines.length

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      bodyStart = index + 1
      break
    }

    if (trimmed.startsWith("#")) {
      continue
    }

    const match = /^([^:]+):(.*)$/.exec(line)
    if (!match) {
      throw new Error(`invalid header line: ${line}`)
    }

    const key = HEADER_NAMES.get(normalizeHeaderName(match[1]))
    if (!key) {
      throw new Error(`unknown header: ${match[1].trim()}`)
    }

    headerValues.set(key, match[2].trim())
  }

  const title = (headerValues.get("title") ?? "").trim()
  if (!title) {
    throw new Error("Title is required")
  }

  const status = headerValues.get("status") ?? "not_started"
  if (!isStatus(status)) {
    throw new Error(`invalid Status: ${status}`)
  }

  const language = headerValues.get("language") ?? "general"
  if (!isLanguage(language)) {
    throw new Error(`invalid Language: ${language}`)
  }

  const priority = headerValues.get("priority") ?? "medium"
  if (!isPriority(priority)) {
    throw new Error(`invalid Priority: ${priority}`)
  }

  return {
    title,
    status,
    language,
    priority,
    effort_hours: parseOptionalNumber(
      headerValues.get("effort_hours") ?? "",
      "Effort-Hours",
    ),
    parent_id: parseOptionalNumber(
      headerValues.get("parent_id") ?? "",
      "Parent-Id",
    ),
    description: lines.slice(bodyStart).join("\n").replace(/\n+$/u, ""),
  }
}

function editorCommand(): string[] {
  const command = process.env["EDITOR"]
    ?? process.env["VISUAL"]
    ?? "vi"

  const argv = parseCommandToArgv(command)
  if (argv.length === 0) {
    throw new Error("EDITOR is empty")
  }

  return argv
}

async function editDraftInEditor(
  mode: "create" | "edit",
  draft: TaskEditorDraft,
  taskId?: number,
): Promise<TaskEditorDraft> {
  const tempDir = mkdtempSync(join(tmpdir(), "lectic-task-editor-"))
  const tempPath = join(tempDir, mode === "create" ? "new-task.txt" : "task.txt")
  const initialText = renderTaskEditorDocument(mode, draft, taskId)

  writeFileSync(tempPath, initialText, "utf8")

  try {
    const proc = Bun.spawn({
      cmd: [...editorCommand(), tempPath],
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`editor exited with code ${exitCode}`)
    }

    const editedText = normalizeText(readFileSync(tempPath, "utf8"))
    return parseTaskEditorDocument(editedText)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function createTaskWithEditor(
  db: Database,
  options?: {
    actor?: string
    session?: string | null
    initial?: Partial<TaskEditorDraft>
    source?: string
  },
): Promise<EditorMutationResult<TaskLike>> {
  const actor = options?.actor ?? process.env["USER"] ?? "assistant"
  const session = options?.session ?? null
  const source = options?.source ?? "editor"

  const initialDraft: TaskEditorDraft = {
    title: options?.initial?.title ?? "",
    description: options?.initial?.description ?? "",
    status: options?.initial?.status ?? "not_started",
    language: options?.initial?.language ?? "general",
    priority: options?.initial?.priority ?? "medium",
    effort_hours: options?.initial?.effort_hours ?? null,
    parent_id: options?.initial?.parent_id ?? null,
  }

  const draft = await editDraftInEditor("create", initialDraft)
  if (draft.parent_id !== null) {
    ensureTaskExists(db, draft.parent_id)
  }

  const createdAt = nowIso()
  const startedAt = STARTABLE_STATUSES.has(draft.status) ? createdAt : null
  const completedAt = draft.status === "completed" ? createdAt : null
  let createdTask: TaskLike | null = null

  const tx = db.transaction(() => {
    const result = db
      .query(
        `INSERT INTO tasks (
          title, description, status, language, priority,
          effort_hours, parent_id, created_at, updated_at,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        draft.title,
        draft.description,
        draft.status,
        draft.language,
        draft.priority,
        draft.effort_hours,
        draft.parent_id,
        createdAt,
        createdAt,
        startedAt,
        completedAt,
      )

    const taskId = Number(result.lastInsertRowid)

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
        draft.status,
        actor,
        session,
        JSON.stringify({
          language: draft.language,
          priority: draft.priority,
          source,
          via: "editor",
        }),
        createdAt,
      )

    createdTask = ensureTaskExists(db, taskId)
  })

  tx()

  return {
    changed: true,
    cancelled: false,
    message: createdTask
      ? `Created task #${createdTask.id}: ${createdTask.title}`
      : "Created task.",
    task: createdTask,
  }
}

export async function editTaskWithEditor(
  db: Database,
  task: TaskLike,
  options?: {
    actor?: string
    session?: string | null
    source?: string
  },
): Promise<EditorMutationResult<TaskLike>> {
  if (task.archived_at) {
    throw new Error("cannot edit an archived task")
  }

  const actor = options?.actor ?? process.env["USER"] ?? "assistant"
  const session = options?.session ?? null
  const source = options?.source ?? "editor"

  const draft = await editDraftInEditor("edit", taskToDraft(task), task.id)
  if (draft.parent_id === task.id) {
    throw new Error("task cannot be its own parent")
  }
  if (draft.parent_id !== null) {
    ensureTaskExists(db, draft.parent_id)
  }

  checkTransition(task.status, draft.status)

  const changedFields = [
    task.title !== draft.title ? "title" : null,
    task.description !== draft.description ? "description" : null,
    task.status !== draft.status ? "status" : null,
    task.language !== draft.language ? "language" : null,
    task.priority !== draft.priority ? "priority" : null,
    task.effort_hours !== draft.effort_hours ? "effort_hours" : null,
    task.parent_id !== draft.parent_id ? "parent_id" : null,
  ].filter((field): field is string => field !== null)

  if (changedFields.length === 0) {
    return {
      changed: false,
      cancelled: false,
      message: `Task #${task.id} has no changes to apply.`,
      task: task,
    }
  }

  const updatedAt = nowIso()
  const startedAt = task.started_at
    ?? (STARTABLE_STATUSES.has(draft.status) ? updatedAt : null)
  const completedAt = draft.status === "completed" ? updatedAt : task.completed_at
  const statusChanged = task.status !== draft.status
  let updatedTask: TaskLike | null = null

  const tx = db.transaction(() => {
    db
      .query(
        `UPDATE tasks
         SET title = ?,
             description = ?,
             status = ?,
             language = ?,
             priority = ?,
             effort_hours = ?,
             parent_id = ?,
             updated_at = ?,
             started_at = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(
        draft.title,
        draft.description,
        draft.status,
        draft.language,
        draft.priority,
        draft.effort_hours,
        draft.parent_id,
        updatedAt,
        startedAt,
        completedAt,
        task.id,
      )

    if (statusChanged) {
      db
        .query(
          `INSERT INTO task_events (
            task_id, event, from_status, to_status, actor,
            session_id, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.id,
          "transition",
          task.status,
          draft.status,
          actor,
          session,
          JSON.stringify({
            source,
            via: "editor",
          }),
          updatedAt,
        )
    }

    db
      .query(
        `INSERT INTO task_events (
          task_id, event, from_status, to_status, actor,
          session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        "edited",
        statusChanged ? task.status : null,
        statusChanged ? draft.status : null,
        actor,
        session,
        JSON.stringify({
          fields: changedFields,
          source,
          via: "editor",
        }),
        updatedAt,
      )

    updatedTask = ensureTaskExists(db, task.id)
  })

  tx()

  return {
    changed: true,
    cancelled: false,
    message: updatedTask
      ? `Updated task #${updatedTask.id}: ${updatedTask.title}`
      : `Updated task #${task.id}.`,
    task: updatedTask,
  }
}
