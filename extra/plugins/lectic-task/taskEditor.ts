import type { Database } from "bun:sqlite"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ALL_PRIORITIES,
  ALL_STATUSES,
  createTask,
  isPriority,
  isStatus,
  updateTask,
} from "./taskCore.ts"
import type { Actor, TaskDraft, TaskRow } from "./taskCore.ts"

export type EditorMutationResult = {
  changed: boolean
  cancelled: boolean
  message: string
  task: TaskRow | null
}

const HEADER_NAMES = new Map<string, keyof TaskDraft>([
  ["title", "title"],
  ["status", "status"],
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

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[ _]+/g, "-")
}

function taskToDraft(task: TaskRow): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
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
  draft: TaskDraft,
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
    `# Allowed priority values: ${ALL_PRIORITIES.join(", ")}`,
    `Title: ${draft.title}`,
    `Status: ${draft.status}`,
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

function parseTaskEditorDocument(content: string): TaskDraft {
  const normalized = normalizeText(content)
  const lines = normalized.split("\n")
  const headerValues = new Map<keyof TaskDraft, string>()
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

  const priority = headerValues.get("priority") ?? "medium"
  if (!isPriority(priority)) {
    throw new Error(`invalid Priority: ${priority}`)
  }

  return {
    title,
    status,
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
  draft: TaskDraft,
  taskId?: number,
): Promise<TaskDraft> {
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
  options: {
    projectKey: string
    who: Actor
    initial?: Partial<TaskDraft>
    source?: string
  },
): Promise<EditorMutationResult> {
  const initialDraft: TaskDraft = {
    title: options.initial?.title ?? "",
    description: options.initial?.description ?? "",
    status: options.initial?.status ?? "not_started",
    priority: options.initial?.priority ?? "medium",
    effort_hours: options.initial?.effort_hours ?? null,
    parent_id: options.initial?.parent_id ?? null,
  }

  const draft = await editDraftInEditor("create", initialDraft)
  const task = createTask(db, options.projectKey, draft, options.who, {
    source: options.source ?? "editor",
    via: "editor",
  })

  return {
    changed: true,
    cancelled: false,
    message: `Created task #${task.id}: ${task.title}`,
    task,
  }
}

export async function editTaskWithEditor(
  db: Database,
  task: TaskRow,
  options: {
    who: Actor
    source?: string
  },
): Promise<EditorMutationResult> {
  if (task.archived_at) {
    throw new Error("cannot edit an archived task")
  }

  const draft = await editDraftInEditor("edit", taskToDraft(task), task.id)
  const result = updateTask(db, task, draft, options.who, {
    source: options.source ?? "editor",
    via: "editor",
  })

  if (result.changedFields.length === 0) {
    return {
      changed: false,
      cancelled: false,
      message: `Task #${task.id} has no changes to apply.`,
      task,
    }
  }

  return {
    changed: true,
    cancelled: false,
    message: `Updated task #${result.task.id}: ${result.task.title}`,
    task: result.task,
  }
}
