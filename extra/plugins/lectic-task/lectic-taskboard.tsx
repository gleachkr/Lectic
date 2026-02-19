#!/usr/bin/env -S lectic script

import "./schema.sql"

import { Database } from "bun:sqlite"
// Keep React and Ink on the same resolver graph to avoid mixed React
// instances at runtime (which can cause invalid child/render errors).
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "https://esm.sh/react@18.3.1"
import {
  Box,
  render,
  Text,
  useApp,
  useInput,
} from "https://esm.sh/ink@5.2.1?deps=react@18.3.1"
import { mkdirSync, watch } from "node:fs"
import { basename, dirname, resolve } from "node:path"

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

type Priority = "low" | "medium" | "high" | "critical"

type TaskRow = {
  id: number
  title: string
  description: string
  status: Status
  language: string
  priority: Priority
  effort_hours: number | null
  updated_at: string
}

type InputMode = "normal" | "filter"

const HELP_HINTS =
  "q quit • / filter • x clear query • Ctrl-D archive done • esc reset"
const FILTER_HINTS = "filter mode: type • enter apply • esc reset"

type TransitionHotkey = {
  key: string
  to: Status
  label: string
}

const TRANSITION_HOTKEYS: TransitionHotkey[] = [
  { key: "N", to: "not_started", label: "not started" },
  { key: "R", to: "researching", label: "researching" },
  { key: "E", to: "researched", label: "researched" },
  { key: "G", to: "planning", label: "planning" },
  { key: "P", to: "planned", label: "planned" },
  { key: "I", to: "implementing", label: "implementing" },
  { key: "C", to: "completed", label: "completed" },
  { key: "T", to: "partial", label: "partial" },
  { key: "B", to: "blocked", label: "blocked" },
  { key: "A", to: "abandoned", label: "abandoned" },
]

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

const ARCHIVEABLE_STATUSES: ReadonlySet<Status> = new Set([
  "completed",
  "abandoned",
])

function defaultActor(): string {
  return process.env["LECTIC_INTERLOCUTOR"]
    ?? process.env["USER"]
    ?? "taskboard"
}

function defaultSession(): string | null {
  return process.env["RUN_ID"] ?? null
}

function availableTransitionHotkeys(task: TaskRow | null): TransitionHotkey[] {
  if (!task) return []
  return TRANSITION_HOTKEYS.filter((entry) => {
    return TRANSITIONS[task.status].has(entry.to)
  })
}

function formatTransitionHints(task: TaskRow | null): string {
  const entries = availableTransitionHotkeys(task)
  if (entries.length === 0) {
    return "none"
  }

  return entries.map((entry) => `${entry.key} ${entry.label}`).join(" • ")
}

function parseArgs(argv: string[]): { dbPath: string } {
  const defaultData = process.env["LECTIC_DATA"]
    ?? `${process.env["HOME"] ?? "."}/.local/share/lectic`
  let dbPath = process.env["LECTIC_TASK_DB"] ?? `${defaultData}/task.sqlite3`

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--db") {
      const value = argv[i + 1]
      if (!value) {
        throw new Error("missing value for --db")
      }
      dbPath = value
      i++
      continue
    }

    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length)
      continue
    }

    if (arg === "-h" || arg === "--help") {
      console.log("Usage: lectic taskboard [--db PATH]")
      process.exit(0)
    }
  }

  return { dbPath: resolve(dbPath) }
}

async function initDb(dbPath: string): Promise<Database> {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  const schemaPath = new URL("./schema.sql", import.meta.url)
  const schemaSql = await Bun.file(schemaPath).text()
  db.exec(schemaSql)
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

function loadTasks(db: Database): TaskRow[] {
  return db
    .query(
      `SELECT id, title, description, status, language, priority,
              effort_hours, updated_at
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
    .all() as TaskRow[]
}

function isDbRelatedFile(dbFileName: string, candidate: string): boolean {
  return candidate === dbFileName
    || candidate === `${dbFileName}-wal`
    || candidate === `${dbFileName}-shm`
    || candidate === `${dbFileName}-journal`
}

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0
  const source = haystack.toLowerCase()
  const query = needle.toLowerCase()

  let score = 0
  let q = 0
  let streak = 0

  for (let i = 0; i < source.length && q < query.length; i++) {
    if (source[i] !== query[q]) continue

    q++
    streak++
    score += 2 + streak
  }

  if (q !== query.length) return -1
  return score - source.length * 0.01
}

function transitionTask(
  db: Database,
  task: TaskRow,
  toStatus: Status,
): { ok: boolean; message: string } {
  if (task.status === toStatus) {
    return { ok: false, message: `Task #${task.id} is already ${toStatus}` }
  }

  if (!TRANSITIONS[task.status].has(toStatus)) {
    return {
      ok: false,
      message: `Invalid transition ${task.status} -> ${toStatus}`,
    }
  }

  const ts = new Date().toISOString()
  const actor = defaultActor()
  const session = defaultSession()

  const startedAt =
    task.status === "not_started"
    && (toStatus === "researching"
      || toStatus === "planning"
      || toStatus === "implementing")
      ? ts
      : null

  const completedAt = toStatus === "completed" ? ts : null

  const tx = db.transaction(() => {
    if (startedAt) {
      db
        .query(
          `UPDATE tasks
           SET status = ?, updated_at = ?, started_at = ?
           WHERE id = ?`
        )
        .run(toStatus, ts, startedAt, task.id)
    } else if (completedAt) {
      db
        .query(
          `UPDATE tasks
           SET status = ?, updated_at = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(toStatus, ts, completedAt, task.id)
    } else {
      db
        .query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(toStatus, ts, task.id)
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
        "transition",
        task.status,
        toStatus,
        actor,
        session,
        JSON.stringify({ source: "taskboard" }),
        ts,
      )
  })

  tx()

  return {
    ok: true,
    message: `Task #${task.id}: ${task.status} -> ${toStatus}`,
  }
}

function archiveTask(db: Database, task: TaskRow): { ok: boolean; message: string } {
  if (!ARCHIVEABLE_STATUSES.has(task.status)) {
    return {
      ok: false,
      message: "Only completed or abandoned tasks can be archived",
    }
  }

  const archivedAt = new Date().toISOString()
  const actor = defaultActor()
  const session = defaultSession()

  const tx = db.transaction(() => {
    db
      .query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archivedAt, archivedAt, task.id)

    db
      .query(
        `INSERT INTO task_events (
          task_id, event, from_status, to_status, actor,
          session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        "archived",
        task.status,
        task.status,
        actor,
        session,
        JSON.stringify({
          archived_at: archivedAt,
          source: "taskboard",
        }),
        archivedAt,
      )
  })

  tx()

  return {
    ok: true,
    message: `Archived task #${task.id}: ${task.title}`,
  }
}

function TaskboardApp(props: { db: Database; dbPath: string }) {
  const { exit } = useApp()
  const [tasks, setTasks] = useState<TaskRow[]>(() => loadTasks(props.db))
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [inputMode, setInputMode] = useState<InputMode>("normal")
  const [statusMessage, setStatusMessage] = useState("")

  const reload = useCallback((note?: string) => {
    try {
      setTasks(loadTasks(props.db))
      if (note) {
        setStatusMessage(note)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Refresh failed: ${message}`)
    }
  }, [props.db])

  useEffect(() => {
    const dbDir = dirname(props.dbPath)
    const dbFileName = basename(props.dbPath)
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const scheduleReload = () => {
      if (closed) return
      if (timer) {
        clearTimeout(timer)
      }

      timer = setTimeout(() => {
        if (closed) return
        reload()
      }, 120)
    }

    const watcher = watch(dbDir, (_eventType, filename) => {
      if (!filename) {
        scheduleReload()
        return
      }

      const candidate = filename.toString()
      if (isDbRelatedFile(dbFileName, candidate)) {
        scheduleReload()
      }
    })

    watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Watch failed: ${message}`)
    })

    return () => {
      closed = true
      if (timer) {
        clearTimeout(timer)
      }
      watcher.close()
    }
  }, [props.dbPath, reload])

  const filtered = useMemo(() => {
    if (!query.trim()) return tasks

    const scored = tasks
      .map((task) => {
        const text = `${task.id} ${task.title} ${task.status} ${task.language}`
        const score = fuzzyScore(text, query)
        return { task, score }
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)

    return scored.map((entry) => entry.task)
  }, [tasks, query])

  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedIndex !== 0) {
        setSelectedIndex(0)
      }
      if (selectedTaskId !== null) {
        setSelectedTaskId(null)
      }
      return
    }

    if (selectedTaskId !== null) {
      const matchedIndex = filtered.findIndex((task) => task.id === selectedTaskId)
      if (matchedIndex >= 0 && matchedIndex !== selectedIndex) {
        setSelectedIndex(matchedIndex)
        return
      }
    }

    if (selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length - 1)
      return
    }

    const currentTask = filtered[selectedIndex]
    if (currentTask && currentTask.id !== selectedTaskId) {
      setSelectedTaskId(currentTask.id)
    }
  }, [filtered, selectedIndex, selectedTaskId])

  const selected = filtered[selectedIndex] ?? null

  const applyTransition = (toStatus: Status) => {
    if (!selected) return
    const result = transitionTask(props.db, selected, toStatus)
    if (result.ok) {
      reload(result.message)
      return
    }
    setStatusMessage(result.message)
  }

  const applyArchive = () => {
    if (!selected) return
    const result = archiveTask(props.db, selected)
    if (result.ok) {
      reload(result.message)
      return
    }
    setStatusMessage(result.message)
  }

  const setSelectionByIndex = (nextIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(filtered.length - 1, nextIndex))
    const nextTask = filtered[clampedIndex] ?? null

    setSelectedIndex(clampedIndex)
    setSelectedTaskId(nextTask?.id ?? null)
  }

  const resetToHome = () => {
    setInputMode("normal")
    setQuery("")
    if (filtered.length > 0) {
      setSelectedIndex(0)
      setSelectedTaskId(filtered[0].id)
    } else {
      setSelectedIndex(0)
      setSelectedTaskId(null)
    }
    setStatusMessage("")
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit()
      return
    }

    if (key.escape) {
      resetToHome()
      return
    }

    if (inputMode === "filter") {
      if (key.return) {
        setInputMode("normal")
        return
      }

      if (key.backspace || key.delete) {
        setQuery((prev) => prev.slice(0, -1))
        return
      }

      if (!key.ctrl && !key.meta && input.length === 1) {
        setQuery((prev) => prev + input)
      }
      return
    }

    if (input === "/") {
      setInputMode("filter")
      return
    }

    if (input === "q") {
      exit()
      return
    }

    if (input === "x") {
      setQuery("")
      setStatusMessage("")
      return
    }

    const isCtrlD = (key.ctrl && input.toLowerCase() === "d")
      || input === "\x04"
    if (isCtrlD) {
      applyArchive()
      return
    }

    if (key.upArrow || input === "k") {
      setSelectionByIndex(selectedIndex - 1)
      return
    }

    if (key.downArrow || input === "j") {
      setSelectionByIndex(selectedIndex + 1)
      return
    }

    const transition = TRANSITION_HOTKEYS.find((entry) => {
      return input === entry.key
    })
    if (transition) {
      applyTransition(transition.to)
      return
    }
  })

  const transitionHints = formatTransitionHints(selected)
  const helpText = inputMode === "filter"
    ? FILTER_HINTS
    : HELP_HINTS

  return (
    <Box flexDirection="column">
      <Text bold>Lectic Taskboard</Text>
      <Text color="gray">
        Query: {query || "(all)"}{inputMode === "filter" ? " [FILTER]" : ""}
      </Text>
      {statusMessage ? <Text color="gray">{statusMessage}</Text> : null}
      <Box marginTop={1}>
        <Box flexDirection="column" width="55%" marginRight={1}>
          <Text underline>Tasks ({filtered.length})</Text>
          {filtered.length === 0 ? (
            <Text color="gray">No matching tasks.</Text>
          ) : (
            filtered.slice(0, 25).map((task, index) => {
              const selectedMark = index === selectedIndex ? "▸" : " "
              return (
                <Text key={task.id} color={index === selectedIndex ? "cyan" : "white"}>
                  {selectedMark} #{task.id} [{task.status}] {task.title}
                </Text>
              )
            })
          )}
        </Box>

        <Box flexDirection="column" width="45%">
          <Text underline>Details</Text>
          {!selected ? (
            <Text color="gray">No task selected.</Text>
          ) : (
            <>
              <Text>#{selected.id} {selected.title}</Text>
              <Text>Status: {selected.status}</Text>
              <Text>Lang: {selected.language}</Text>
              <Text>Priority: {selected.priority}</Text>
              <Text>
                Effort: {selected.effort_hours === null ? "-" : `${selected.effort_hours}h`}
              </Text>
              <Text>Updated: {selected.updated_at}</Text>
              <Text wrap="wrap">{selected.description || "(no description)"}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Actions:</Text>
                <Text color="gray">{transitionHints}</Text>
                <Text color="gray">
                  Ctrl-D archive (completed/abandoned only)
                </Text>
              </Box>
            </>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{helpText}</Text>
      </Box>
    </Box>
  )
}

async function main(): Promise<void> {
  let db: Database | null = null
  try {
    const { dbPath } = parseArgs(process.argv.slice(2))
    db = await initDb(dbPath)

    const { waitUntilExit } = render(
      <TaskboardApp db={db} dbPath={dbPath} />,
      { exitOnCtrlC: false },
    )

    await waitUntilExit()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`taskboard error: ${message}`)
    process.exitCode = 1
  } finally {
    db?.close(false)
  }
}

await main()
