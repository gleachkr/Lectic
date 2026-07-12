#!/usr/bin/env -S lectic script

import "./schema.sql"

import { Database } from "bun:sqlite"
import React, {
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
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { memorySearchScore } from "./memory-browser-search.ts"

type Scope = "user" | "project"
type ScopeFilter = "all" | Scope
type Status = "active" | "superseded" | "deleted"
type InputMode = "normal" | "search"

type MemoryRow = {
  id: number
  scope: Scope
  project_key: string | null
  kind: string
  gist: string
  content: string
  source_file: string | null
  source_interlocutor: string | null
  created_at: string
  updated_at: string
  accessed_at: string | null
  access_count: number
  status: Status
  supersedes_id: number | null
}

type BrowserArgs = {
  dbPath: string
  projectKey: string
  query: string
}

const KINDS = [
  "all",
  "preference",
  "decision",
  "project-fact",
  "procedure",
  "error-solution",
  "constraint",
  "other",
] as const

const SCOPES: ScopeFilter[] = ["all", "project", "user"]

function usage(): string {
  return [
    "Usage:",
    "  lectic memory browse [QUERY]",
    "",
    "The browser shows user memories and memories for the current project.",
    "Use / to search, j/k or arrows to move, and q to quit.",
  ].join("\n")
}

function parseArgs(argv: string[]): BrowserArgs | null {
  let dbPath = ""
  let projectKey = ""
  const query: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") {
      console.log(usage())
      return null
    }
    if (arg === "--db" || arg === "--project-key") {
      const value = argv[i + 1]
      if (!value) throw new Error(`missing value for ${arg}`)
      if (arg === "--db") dbPath = value
      else projectKey = value
      i++
      continue
    }
    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length)
      continue
    }
    if (arg.startsWith("--project-key=")) {
      projectKey = arg.slice("--project-key=".length)
      continue
    }
    query.push(arg)
  }

  if (!dbPath || !projectKey) {
    throw new Error("browser must be launched through `lectic memory browse`")
  }

  return {
    dbPath: resolve(dbPath),
    projectKey,
    query: query.join(" ").trim(),
  }
}

async function openDb(path: string): Promise<Database> {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  const schema = await Bun.file(
    new URL("./schema.sql", import.meta.url),
  ).text()
  db.exec(schema)
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

function loadMemories(db: Database, projectKey: string): MemoryRow[] {
  return db.query(`
    SELECT * FROM memories
    WHERE scope = 'user' OR project_key = ?
    ORDER BY updated_at DESC, id DESC
  `).all(projectKey) as MemoryRow[]
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 10)
}

function cycle<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current)
  return values[(index + 1) % values.length] ?? values[0]
}

function BrowserApp(props: {
  memories: MemoryRow[]
  initialQuery: string
}) {
  const { exit } = useApp()
  const [query, setQuery] = useState(props.initialQuery)
  const [scope, setScope] = useState<ScopeFilter>("all")
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all")
  const [includeInactive, setIncludeInactive] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>("normal")
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filtered = useMemo(() => {
    return props.memories
      .map((memory) => ({
        memory,
        score: memorySearchScore(memory, query),
      }))
      .filter(({ memory, score }) => {
        if (score < 0) return false
        if (!includeInactive && memory.status !== "active") return false
        if (scope !== "all" && memory.scope !== scope) return false
        return kind === "all" || memory.kind === kind
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return b.memory.updated_at.localeCompare(a.memory.updated_at)
      })
      .map(({ memory }) => memory)
  }, [props.memories, query, scope, kind, includeInactive])

  useEffect(() => {
    setSelectedIndex((current) => {
      return Math.max(0, Math.min(current, filtered.length - 1))
    })
  }, [filtered.length])

  const selected = filtered[selectedIndex] ?? null
  const rowLimit = Math.max(5, (process.stdout.rows ?? 24) - 9)
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(rowLimit / 2),
      filtered.length - rowLimit,
    ),
  )
  const visible = filtered.slice(windowStart, windowStart + rowLimit)

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "\x03") {
      exit()
      return
    }

    if (inputMode === "search") {
      if (key.escape || key.return) {
        setInputMode("normal")
        return
      }
      if (key.backspace || key.delete) {
        setQuery((current) => current.slice(0, -1))
        return
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setQuery((current) => current + input)
      }
      return
    }

    if (input === "q") {
      exit()
      return
    }
    if (input === "/") {
      setInputMode("search")
      return
    }
    if (input === "x" || key.escape) {
      setQuery("")
      setSelectedIndex(0)
      return
    }
    if (input === "s") {
      setScope((current) => cycle(SCOPES, current))
      setSelectedIndex(0)
      return
    }
    if (input === "t") {
      setKind((current) => cycle(KINDS, current))
      setSelectedIndex(0)
      return
    }
    if (input === "i") {
      setIncludeInactive((current) => !current)
      setSelectedIndex(0)
      return
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((current) => Math.max(0, current - 1))
      return
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((current) => {
        return Math.min(filtered.length - 1, current + 1)
      })
    }
  })

  const mode = inputMode === "search" ? " [SEARCH]" : ""
  const status = includeInactive ? "all" : "active"

  return (
    <Box flexDirection="column">
      <Text bold>Lectic Memory</Text>
      <Text color="gray">
        Search: {query || "(none)"}{mode}
      </Text>
      <Text color="gray">
        Scope: {scope} • Kind: {kind} • Status: {status}
      </Text>
      <Box marginTop={1}>
        <Box flexDirection="column" width="45%" marginRight={2}>
          <Text underline>Memories ({filtered.length})</Text>
          {visible.length === 0 ? (
            <Text color="gray">No matching memories.</Text>
          ) : visible.map((memory, offset) => {
            const index = windowStart + offset
            const mark = index === selectedIndex ? "▸" : " "
            const color = index === selectedIndex ? "cyan" : "white"
            return (
              <Text key={memory.id} color={color} wrap="truncate-end">
                {mark} #{memory.id} [{memory.kind}] {memory.gist}
              </Text>
            )
          })}
        </Box>
        <Box flexDirection="column" width="55%">
          <Text underline>Details</Text>
          {!selected ? (
            <Text color="gray">No memory selected.</Text>
          ) : (
            <>
              <Text bold>#{selected.id} {selected.gist}</Text>
              <Text>
                {selected.scope} • {selected.kind} • {selected.status}
              </Text>
              <Text>Updated: {formatDate(selected.updated_at)}</Text>
              {selected.source_file ? (
                <Text wrap="truncate-end">
                  Source: {selected.source_file}
                </Text>
              ) : null}
              <Box marginTop={1}>
                <Text wrap="wrap">{selected.content}</Text>
              </Box>
            </>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          / search • j/k move • s scope • t kind • i inactive • x clear • q quit
        </Text>
      </Box>
    </Box>
  )
}

async function main(): Promise<void> {
  let db: Database | null = null
  let altScreen = false
  let failed = false

  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args) return
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("browse requires an interactive terminal")
    }

    db = await openDb(args.dbPath)
    const memories = loadMemories(db, args.projectKey)

    process.stdout.write("\x1b[?1049h\x1b[?25l")
    altScreen = true

    const { waitUntilExit } = render(
      <BrowserApp memories={memories} initialQuery={args.query} />,
      { exitOnCtrlC: false },
    )
    await waitUntilExit()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`memory browse error: ${message}`)
    failed = true
  } finally {
    db?.close(false)
    if (altScreen) {
      process.stdout.write("\x1b[?25h\x1b[?1049l")
    }
  }

  if (failed) process.exit(1)
}

await main()
