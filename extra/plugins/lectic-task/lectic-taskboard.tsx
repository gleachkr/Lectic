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

import { createTaskWithEditor, editTaskWithEditor } from "./taskEditor.ts"
import { defaultDbPath, projectIdentity } from "./project.ts"
import type { ProjectIdentity } from "./project.ts"
import {
  PRIORITY_ORDER_SQL,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TaskError,
  archiveTask as coreArchiveTask,
  defaultActor,
  defaultSession,
  getTask,
  transitionTask as coreTransitionTask,
} from "./taskCore.ts"
import type { Actor, Status, TaskRow } from "./taskCore.ts"

type InputMode = "normal" | "filter"

type TaskboardExitAction =
  | { kind: "quit" }
  | { kind: "create" }
  | { kind: "edit"; taskId: number }

const HELP_HINTS = [
  "q quit",
  "/ filter",
  "c create",
  "x clear query",
  "esc reset",
].join(" • ")
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

function who(): Actor {
  return { actor: defaultActor(), session: defaultSession() }
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

type BoardScope = {
  project: ProjectIdentity
  allProjects: boolean
}

function parseArgs(argv: string[]): { dbPath: string; scope: BoardScope } {
  let dbPath = defaultDbPath()
  let projectOverride = process.env["LECTIC_TASK_PROJECT"]
  let allProjects = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--db" || arg === "--project") {
      const value = argv[i + 1]
      if (!value) {
        throw new Error(`missing value for ${arg}`)
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

    if (arg === "--all-projects") {
      allProjects = true
      continue
    }

    if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: lectic taskboard [--db PATH] [--project KEY] [--all-projects]",
      )
      process.exit(0)
    }
  }

  return {
    dbPath: resolve(dbPath),
    scope: { project: projectIdentity(projectOverride), allProjects },
  }
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

function loadTasks(db: Database, scope: BoardScope): TaskRow[] {
  const where = ["archived_at IS NULL"]
  const values: string[] = []
  if (!scope.allProjects) {
    where.push("project_key = ?")
    values.push(scope.project.key)
  }

  return db
    .query(
      `SELECT *
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY ${PRIORITY_ORDER_SQL} ASC, updated_at DESC, id DESC`
    )
    .all(...values) as TaskRow[]
}

// Hand the terminal to a child process. Ink stops listening when it unmounts,
// but it never pauses process.stdin, and under Bun the stream keeps reading
// the tty in the background, so an editor spawned with an inherited stdin
// only sees the keystrokes the parent doesn't win. Bun's stdin releases its
// reader on the "pause" event, but Readable.pause() only emits that event
// when the stream is flowing, and Ink reads in paused ("readable") mode, so
// emit it directly. Ink re-acquires the reader on its next "readable" listener.
function releaseTerminalInput(): void {
  process.stdin.pause()
  process.stdin.emit("pause")
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
  try {
    coreTransitionTask(db, task, toStatus, who(), {
      payload: { source: "taskboard" },
    })
    return {
      ok: true,
      message: `Task #${task.id}: ${task.status} -> ${toStatus}`,
    }
  } catch (error) {
    if (error instanceof TaskError) return { ok: false, message: error.message }
    throw error
  }
}

// The board only archives finished tasks, as a guard against a stray
// keypress; the CLI is deliberately more permissive.
function archiveTask(db: Database, task: TaskRow): { ok: boolean; message: string } {
  if (!TERMINAL_STATUSES.has(task.status)) {
    return {
      ok: false,
      message: "Only completed or abandoned tasks can be archived",
    }
  }

  try {
    coreArchiveTask(db, task, who(), { source: "taskboard" })
    return {
      ok: true,
      message: `Archived task #${task.id}: ${task.title}`,
    }
  } catch (error) {
    if (error instanceof TaskError) return { ok: false, message: error.message }
    throw error
  }
}

function TaskboardApp(props: {
  db: Database
  dbPath: string
  scope: BoardScope
  initialStatusMessage: string
  onExitAction: (action: TaskboardExitAction) => void
}) {
  const { exit } = useApp()
  const [tasks, setTasks] = useState<TaskRow[]>(
    () => loadTasks(props.db, props.scope),
  )
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [inputMode, setInputMode] = useState<InputMode>("normal")
  const [statusMessage, setStatusMessage] = useState(props.initialStatusMessage)

  const reload = useCallback((note?: string) => {
    try {
      setTasks(loadTasks(props.db, props.scope))
      if (note) {
        setStatusMessage(note)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Refresh failed: ${message}`)
    }
  }, [props.db, props.scope])

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
        const text = `${task.id} ${task.title} ${task.status}`
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
      props.onExitAction({ kind: "quit" })
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
      props.onExitAction({ kind: "quit" })
      exit()
      return
    }

    if (input === "x") {
      setQuery("")
      setStatusMessage("")
      return
    }

    if (input === "c") {
      props.onExitAction({ kind: "create" })
      exit()
      return
    }

    if (input === "e" && selected) {
      props.onExitAction({ kind: "edit", taskId: selected.id })
      exit()
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
        Project: {props.scope.allProjects
          ? "(all projects)"
          : `${props.scope.project.label} (${props.scope.project.source})`}
      </Text>
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
              {props.scope.allProjects
                ? <Text>Project: {selected.project_key}</Text>
                : null}
              <Text>Status: {selected.status}</Text>
              <Text>Priority: {selected.priority}</Text>
              <Text>
                Effort: {selected.effort_hours === null ? "-" : `${selected.effort_hours}h`}
              </Text>
              <Text>Updated: {selected.updated_at}</Text>
              <Text wrap="wrap">{selected.description || "(no description)"}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Actions:</Text>
                <Text color="gray">e edit</Text>
                <Text color="gray">{transitionHints}</Text>
                <Text color="gray">Ctrl-D archive</Text>
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
    const { dbPath, scope } = parseArgs(process.argv.slice(2))
    db = await initDb(dbPath)

    let statusMessage = ""

    while (true) {
      let exitAction: TaskboardExitAction = { kind: "quit" }

      // Ink leaves its last frame on screen when it unmounts. That is what
      // we want on quit, but before an editor round erase the board so the
      // next render lands where the old one was instead of below it.
      const board = render(
        <TaskboardApp
          db={db}
          dbPath={dbPath}
          scope={scope}
          initialStatusMessage={statusMessage}
          onExitAction={(action) => {
            exitAction = action
            if (action.kind !== "quit") board.clear()
          }}
        />,
        { exitOnCtrlC: false },
      )

      await board.waitUntilExit()
      releaseTerminalInput()
      statusMessage = ""

      if (exitAction.kind === "quit") {
        break
      }

      try {
        if (exitAction.kind === "create") {
          const result = await createTaskWithEditor(db, {
            projectKey: scope.project.key,
            who: who(),
            source: "taskboard",
          })
          statusMessage = result.message
          continue
        }

        const task = getTask(db, exitAction.taskId)

        if (!task) {
          statusMessage = `Task #${exitAction.taskId} no longer exists.`
          continue
        }

        const result = await editTaskWithEditor(db, task, {
          who: who(),
          source: "taskboard",
        })
        statusMessage = result.message
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        statusMessage = `Editor action failed: ${message}`
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`taskboard error: ${message}`)
    process.exitCode = 1
  } finally {
    db?.close(false)
  }
}

await main()
