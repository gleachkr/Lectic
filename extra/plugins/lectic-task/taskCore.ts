import type { Database } from "bun:sqlite"

// Shared domain model and mutations for the task plugin. The CLI, the
// $EDITOR flow, and the Ink taskboard all go through this module so that
// the state machine and event bookkeeping are defined exactly once.

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

export type Priority = "low" | "medium" | "high" | "critical"

export type ArtifactKind = "report" | "plan" | "summary" | "code" | "doc" | "other"

export type TaskRow = {
  id: number
  project_key: string
  title: string
  description: string
  status: Status
  priority: Priority
  effort_hours: number | null
  parent_id: number | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
}

export type TaskEventRow = {
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

export type ArtifactRow = {
  id: number
  task_id: number
  kind: string
  path: string
  summary: string
  created_at: string
}

export type NoteRow = {
  id: number
  task_id: number
  note: string
  actor: string
  session_id: string | null
  created_at: string
}

// Who performed a mutation, recorded on every task_events row.
export type Actor = {
  actor: string
  session: string | null
}

export type TaskDraft = {
  title: string
  description: string
  status: Status
  priority: Priority
  effort_hours: number | null
  parent_id: number | null
}

export class TaskError extends Error {
  code: string
  details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

export const ALL_STATUSES: readonly Status[] = [
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

export const ALL_PRIORITIES: readonly Priority[] = [
  "low",
  "medium",
  "high",
  "critical",
] as const

export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "report",
  "plan",
  "summary",
  "code",
  "doc",
  "other",
] as const

export const TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
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

// Entering one of these statuses stamps started_at (if not already set).
export const STARTABLE_STATUSES: ReadonlySet<Status> = new Set([
  "researching",
  "planning",
  "implementing",
])

export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set([
  "completed",
  "abandoned",
])

// Shared ORDER BY fragment: critical first, then high, medium, low.
export const PRIORITY_ORDER_SQL = `
  CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    ELSE 3
  END`

export function isStatus(value: string): value is Status {
  return (ALL_STATUSES as readonly string[]).includes(value)
}

export function isPriority(value: string): value is Priority {
  return (ALL_PRIORITIES as readonly string[]).includes(value)
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ALL_ARTIFACT_KINDS as readonly string[]).includes(value)
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function defaultActor(): string {
  return process.env["LECTIC_INTERLOCUTOR"]
    ?? process.env["USER"]
    ?? process.env["USERNAME"]
    ?? "assistant"
}

export function defaultSession(): string | null {
  return process.env["RUN_ID"]
    ?? process.env["LECTIC_SESSION"]
    ?? null
}

// Escape a user query for use inside a LIKE '%...%' pattern, so that % and
// _ in the query match themselves. Pair with `ESCAPE '\'`.
export function likePattern(query: string): string {
  const escaped = query.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`)
  return `%${escaped}%`
}

export function getTask(db: Database, taskId: number): TaskRow | null {
  return db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as TaskRow | null
}

export function ensureTaskExists(db: Database, taskId: number): TaskRow {
  const task = getTask(db, taskId)
  if (!task) {
    throw new TaskError("TASK_NOT_FOUND", `task not found: ${taskId}`)
  }
  return task
}

export function checkTransition(fromStatus: Status, toStatus: Status): void {
  if (fromStatus === toStatus) {
    throw new TaskError(
      "INVALID_TRANSITION",
      `task is already in status '${toStatus}'`,
    )
  }

  if (!TRANSITIONS[fromStatus].has(toStatus)) {
    throw new TaskError(
      "INVALID_TRANSITION",
      `cannot transition ${fromStatus} -> ${toStatus}`,
    )
  }
}

// Validate a proposed parent: it must exist and must not make a cycle.
// `taskId` is undefined when the child does not exist yet.
export function checkParent(
  db: Database,
  parentId: number,
  taskId?: number,
): void {
  if (taskId !== undefined && parentId === taskId) {
    throw new TaskError("INVALID_ARGUMENT", "task cannot be its own parent")
  }

  let cursor: number | null = parentId
  const seen = new Set<number>()
  while (cursor !== null) {
    if (cursor === taskId) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `parent ${parentId} would create a cycle`,
      )
    }
    if (seen.has(cursor)) break
    seen.add(cursor)
    cursor = ensureTaskExists(db, cursor).parent_id
  }
}

export function insertEvent(
  db: Database,
  taskId: number,
  event: string,
  who: Actor,
  options: {
    from?: Status | null
    to?: Status | null
    payload?: Record<string, unknown>
    at?: string
  } = {},
): void {
  db
    .query(
      `INSERT INTO task_events (
        task_id, event, from_status, to_status, actor,
        session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      event,
      options.from ?? null,
      options.to ?? null,
      who.actor,
      who.session,
      JSON.stringify(options.payload ?? {}),
      options.at ?? nowIso(),
    )
}

export function createTask(
  db: Database,
  projectKey: string,
  draft: TaskDraft,
  who: Actor,
  payload: Record<string, unknown> = {},
): TaskRow {
  const title = draft.title.trim()
  if (!title) {
    throw new TaskError("INVALID_ARGUMENT", "title is required")
  }

  const createdAt = nowIso()
  const startedAt = STARTABLE_STATUSES.has(draft.status) ? createdAt : null
  const completedAt = draft.status === "completed" ? createdAt : null

  return db.transaction(() => {
    if (draft.parent_id !== null) {
      checkParent(db, draft.parent_id)
    }

    const result = db
      .query(
        `INSERT INTO tasks (
          project_key, title, description, status, priority,
          effort_hours, parent_id, created_at, updated_at,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectKey,
        title,
        draft.description,
        draft.status,
        draft.priority,
        draft.effort_hours,
        draft.parent_id,
        createdAt,
        createdAt,
        startedAt,
        completedAt,
      )

    const taskId = Number(result.lastInsertRowid)
    insertEvent(db, taskId, "created", who, {
      to: draft.status,
      payload: { title, priority: draft.priority, ...payload },
      at: createdAt,
    })

    return ensureTaskExists(db, taskId)
  })()
}

export function updateTask(
  db: Database,
  task: TaskRow,
  draft: TaskDraft,
  who: Actor,
  payload: Record<string, unknown> = {},
): { task: TaskRow; changedFields: string[] } {
  if (task.archived_at) {
    throw new TaskError("NOT_ALLOWED", "cannot edit an archived task")
  }

  const title = draft.title.trim()
  if (!title) {
    throw new TaskError("INVALID_ARGUMENT", "title is required")
  }

  const changedFields = ([
    ["title", task.title !== title],
    ["description", task.description !== draft.description],
    ["status", task.status !== draft.status],
    ["priority", task.priority !== draft.priority],
    ["effort_hours", task.effort_hours !== draft.effort_hours],
    ["parent_id", task.parent_id !== draft.parent_id],
  ] as const)
    .filter(([, changed]) => changed)
    .map(([field]) => field)

  if (changedFields.length === 0) {
    return { task, changedFields }
  }

  const statusChanged = task.status !== draft.status
  if (statusChanged) {
    checkTransition(task.status, draft.status)
  }

  const updatedAt = nowIso()
  const startedAt = task.started_at
    ?? (STARTABLE_STATUSES.has(draft.status) ? updatedAt : null)
  const completedAt = draft.status === "completed"
    ? updatedAt
    : task.completed_at

  return db.transaction(() => {
    if (draft.parent_id !== null) {
      checkParent(db, draft.parent_id, task.id)
    }

    db
      .query(
        `UPDATE tasks
         SET title = ?,
             description = ?,
             status = ?,
             priority = ?,
             effort_hours = ?,
             parent_id = ?,
             updated_at = ?,
             started_at = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        draft.description,
        draft.status,
        draft.priority,
        draft.effort_hours,
        draft.parent_id,
        updatedAt,
        startedAt,
        completedAt,
        task.id,
      )

    if (statusChanged) {
      insertEvent(db, task.id, "transition", who, {
        from: task.status,
        to: draft.status,
        payload,
        at: updatedAt,
      })
    }

    insertEvent(db, task.id, "edited", who, {
      from: statusChanged ? task.status : null,
      to: statusChanged ? draft.status : null,
      payload: { fields: changedFields, ...payload },
      at: updatedAt,
    })

    return { task: ensureTaskExists(db, task.id), changedFields }
  })()
}

export function transitionTask(
  db: Database,
  task: TaskRow,
  toStatus: Status,
  who: Actor,
  options: { note?: string | null; payload?: Record<string, unknown> } = {},
): TaskRow {
  if (task.archived_at) {
    throw new TaskError("NOT_ALLOWED", "cannot transition an archived task")
  }

  checkTransition(task.status, toStatus)

  const note = options.note?.trim() || null
  const updatedAt = nowIso()
  const startedAt = task.started_at
    ?? (STARTABLE_STATUSES.has(toStatus) ? updatedAt : null)
  const completedAt = toStatus === "completed" ? updatedAt : task.completed_at

  return db.transaction(() => {
    db
      .query(
        `UPDATE tasks
         SET status = ?, updated_at = ?, started_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(toStatus, updatedAt, startedAt, completedAt, task.id)

    insertEvent(db, task.id, "transition", who, {
      from: task.status,
      to: toStatus,
      payload: { note, ...(options.payload ?? {}) },
      at: updatedAt,
    })

    if (note) {
      db
        .query(
          `INSERT INTO task_notes (
            task_id, note, actor, session_id, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(task.id, note, who.actor, who.session, updatedAt)
    }

    return ensureTaskExists(db, task.id)
  })()
}

export function archiveTask(
  db: Database,
  task: TaskRow,
  who: Actor,
  payload: Record<string, unknown> = {},
): TaskRow {
  if (task.archived_at !== null) {
    throw new TaskError("NOT_ALLOWED", `task ${task.id} is already archived`)
  }

  const archivedAt = nowIso()

  return db.transaction(() => {
    db
      .query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archivedAt, archivedAt, task.id)

    insertEvent(db, task.id, "archived", who, {
      from: task.status,
      to: task.status,
      payload: { archived_at: archivedAt, ...payload },
      at: archivedAt,
    })

    return ensureTaskExists(db, task.id)
  })()
}

export function addNote(
  db: Database,
  taskId: number,
  text: string,
  who: Actor,
): string {
  const note = text.trim()
  if (!note) {
    throw new TaskError("INVALID_ARGUMENT", "note text is required")
  }

  const createdAt = nowIso()

  db.transaction(() => {
    ensureTaskExists(db, taskId)

    db
      .query(
        `INSERT INTO task_notes (
          task_id, note, actor, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, note, who.actor, who.session, createdAt)

    insertEvent(db, taskId, "noted", who, {
      payload: { note },
      at: createdAt,
    })
  })()

  return note
}

export function attachArtifact(
  db: Database,
  taskId: number,
  kind: ArtifactKind,
  path: string,
  summary: string,
  who: Actor,
): void {
  const createdAt = nowIso()

  db.transaction(() => {
    ensureTaskExists(db, taskId)

    db
      .query(
        `INSERT INTO artifacts (
          task_id, kind, path, summary, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, kind, path, summary, createdAt)

    insertEvent(db, taskId, "artifact_attached", who, {
      payload: { kind, path },
      at: createdAt,
    })
  })()
}
