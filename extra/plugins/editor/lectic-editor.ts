#!/usr/bin/env -S lectic script

import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { createConnection as createNetConnection } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

type Severity = "error" | "warning" | "info" | "log"

type BridgeResponse = {
  id?: string
  ok?: boolean
  result?: {
    choice?: string | null
    approved?: boolean
  }
  error?: {
    code?: string
    message?: string
  }
}

type ParsedFlags = {
  positional: string[]
  values: Map<string, string[]>
  booleans: Set<string>
}

function usage(): string {
  return [
    "Usage:",
    "  lectic editor progress begin --token ID --title TEXT [options]",
    "  lectic editor progress report --token ID [options]",
    "  lectic editor progress end --token ID [options]",
    "  lectic editor approve --title TEXT [options]",
    "  lectic editor pick --title TEXT --option TEXT [--option TEXT ...]",
    "",
    "Commands:",
    "  progress begin   Start an LSP work-done progress item",
    "  progress report  Update an existing progress item",
    "  progress end     Finish an existing progress item",
    "  approve          Ask the editor for Allow/Deny approval",
    "  pick             Ask the editor to choose from a list",
    "",
    "Common options:",
    "  --message TEXT   Extra body text to show in the prompt",
    "  --severity S     error|warning|info|log (for approve/pick)",
    "  --socket PATH    Connect to an explicit socket/pipe path",
    "",
    "approve options:",
    "  --allow TEXT     Label for the allow action (default: Allow)",
    "  --deny TEXT      Label for the deny action (default: Deny)",
    "",
    "pick options:",
    "  --option TEXT    Add a selectable option (repeatable)",
    "",
    "progress options:",
    "  --percentage N   Progress percentage for begin/report",
    "",
    "Discovery:",
    "  If --socket is omitted, the command searches upward from the",
    "  active Lectic file directory (or cwd) for an active LSP bridge.",
  ].join("\n")
}

function getBaseDir(type: "config" | "data" | "cache" | "state"): string {
  const home = homedir()

  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"]
      || join(home, "AppData", "Local")
    const roaming = process.env["APPDATA"] || join(home, "AppData", "Roaming")
    if (type === "config" || type === "data") {
      return roaming
    }
    return local
  }

  if (process.platform === "darwin") {
    const library = join(home, "Library")
    if (type === "config") {
      return join(library, "Preferences")
    }
    if (type === "cache") {
      return join(library, "Caches")
    }
    return join(library, "Application Support")
  }

  const defaults = {
    config: ["XDG_CONFIG_HOME", ".config"],
    data: ["XDG_DATA_HOME", ".local/share"],
    cache: ["XDG_CACHE_HOME", ".cache"],
    state: ["XDG_STATE_HOME", ".local/state"],
  } as const
  const [envName, rel] = defaults[type]
  return process.env[envName] || join(home, rel)
}

function lecticStateDir(): string {
  return process.env["LECTIC_STATE"] || join(getBaseDir("state"), "lectic")
}

function normalizeRoot(root: string): string {
  const resolved = resolve(root)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function socketHash(root: string): string {
  return createHash("sha256")
    .update(normalizeRoot(root))
    .digest("hex")
    .slice(0, 24)
}

function socketPathForRoot(root: string): string {
  const hash = socketHash(root)
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lectic-editor-${hash}`
  }
  return join(lecticStateDir(), "lsp", `editor-${hash}.sock`)
}

function candidateRoots(startDir: string): string[] {
  const roots: string[] = []
  let current = normalizeRoot(startDir)

  for (;;) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) return roots
    current = parent
  }
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = []
  const values = new Map<string, string[]>()
  const booleans = new Set<string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") {
      booleans.add("help")
      continue
    }

    if (!arg.startsWith("--")) {
      positional.push(arg)
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

  return { positional, values, booleans }
}

function flagValue(parsed: ParsedFlags, name: string): string | undefined {
  const list = parsed.values.get(name)
  return list && list.length > 0 ? list[list.length - 1] : undefined
}

function flagValues(parsed: ParsedFlags, name: string): string[] {
  return parsed.values.get(name) ?? []
}

function nonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

function parseSeverity(value: string | undefined): Severity | undefined {
  if (value === undefined) return undefined
  if (
    value === "error" ||
    value === "warning" ||
    value === "info" ||
    value === "log"
  ) {
    return value
  }
  throw new Error("--severity must be one of: error, warning, info, log")
}

function parsePercentage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error("--percentage must be a finite number")
  }
  return parsed
}

function commandStartDir(): string {
  const lecticFile = process.env["LECTIC_FILE"]
  if (lecticFile && lecticFile.trim() !== "") {
    return dirname(lecticFile)
  }
  return process.cwd()
}

async function socketExists(path: string): Promise<boolean> {
  if (process.platform === "win32") return true
  return existsSync(path)
}

async function canConnect(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createNetConnection(path)
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(150, () => finish(false))
  })
}

async function connectAndRequest(
  socketPath: string,
  request: Record<string, unknown>
): Promise<BridgeResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createNetConnection(socketPath)
    let buffer = ""
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      socket.end()
    }

    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n")
      if (request.id === undefined) {
        finish(() => resolve({ ok: true }))
      }
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      finish(() => resolve(JSON.parse(line) as BridgeResponse))
    })
    socket.once("error", (error) => finish(() => reject(error)))
  })
}

async function findSocketPath(explicitPath?: string): Promise<string> {
  if (explicitPath) return explicitPath

  const override = process.env["LECTIC_EDITOR_SOCKET"]
  if (override && override.trim() !== "") return override

  const startDir = commandStartDir()
  for (const root of candidateRoots(startDir)) {
    const socketPath = socketPathForRoot(root)
    if (!(await socketExists(socketPath))) continue
    if (!(await canConnect(socketPath))) continue
    return socketPath
  }

  throw new Error(
    `could not find an active Lectic editor bridge above ${startDir}`
  )
}

async function bridgeRequest(
  request: Record<string, unknown>,
  explicitSocket?: string
): Promise<BridgeResponse> {
  const socketPath = await findSocketPath(explicitSocket)
  const response = await connectAndRequest(socketPath, request)

  if (request.id !== undefined && response.ok !== true) {
    const message = response.error?.message || "editor bridge request failed"
    throw new Error(message)
  }

  return response
}

async function runProgress(parsed: ParsedFlags): Promise<void> {
  const mode = parsed.positional[1]
  if (mode !== "begin" && mode !== "report" && mode !== "end") {
    throw new Error("progress requires one of: begin, report, end")
  }

  const token = nonEmpty(flagValue(parsed, "token"), "--token")
  const message = flagValue(parsed, "message")
  const explicitSocket = flagValue(parsed, "socket")

  if (mode === "begin") {
    const title = nonEmpty(flagValue(parsed, "title"), "--title")
    const percentage = parsePercentage(flagValue(parsed, "percentage"))
    await bridgeRequest(
      {
        id: `progress-begin-${Date.now()}`,
        type: "progress.begin",
        params: { token, title, message, percentage },
      },
      explicitSocket
    )
    return
  }

  if (mode === "report") {
    const percentage = parsePercentage(flagValue(parsed, "percentage"))
    await bridgeRequest(
      {
        id: `progress-report-${Date.now()}`,
        type: "progress.report",
        params: { token, message, percentage },
      },
      explicitSocket
    )
    return
  }

  await bridgeRequest(
    {
      id: `progress-end-${Date.now()}`,
      type: "progress.end",
      params: { token, message },
    },
    explicitSocket
  )
}

async function runApprove(parsed: ParsedFlags): Promise<void> {
  const title = nonEmpty(flagValue(parsed, "title"), "--title")
  const message = flagValue(parsed, "message")
  const allow = flagValue(parsed, "allow")
  const deny = flagValue(parsed, "deny")
  const severity = parseSeverity(flagValue(parsed, "severity"))
  const explicitSocket = flagValue(parsed, "socket")

  const response = await bridgeRequest(
    {
      id: `approve-${Date.now()}`,
      type: "query.confirm",
      params: { title, message, allow, deny, severity },
    },
    explicitSocket
  )

  const approved = response.result?.approved === true
  process.exit(approved ? 0 : 1)
}

async function runPick(parsed: ParsedFlags): Promise<void> {
  const title = nonEmpty(flagValue(parsed, "title"), "--title")
  const message = flagValue(parsed, "message")
  const options = flagValues(parsed, "option")
  const severity = parseSeverity(flagValue(parsed, "severity"))
  const explicitSocket = flagValue(parsed, "socket")

  if (options.length === 0) {
    throw new Error("pick requires at least one --option value")
  }

  const response = await bridgeRequest(
    {
      id: `pick-${Date.now()}`,
      type: "query.pick",
      params: { title, message, options, severity },
    },
    explicitSocket
  )

  const choice = response.result?.choice
  if (typeof choice === "string") {
    console.log(choice)
    process.exit(0)
  }

  process.exit(1)
}

async function main(): Promise<void> {
  const parsed = parseFlags(process.argv.slice(2))
  if (parsed.booleans.has("help") || parsed.positional.length === 0) {
    console.log(usage())
    return
  }

  const [command] = parsed.positional
  switch (command) {
    case "progress":
      await runProgress(parsed)
      return
    case "approve":
      await runApprove(parsed)
      return
    case "pick":
      await runPick(parsed)
      return
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`error: ${message}`)
  console.error("")
  console.error(usage())
  process.exit(1)
})
