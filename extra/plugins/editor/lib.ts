import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { createConnection as createNetConnection } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export type Severity = "error" | "warning" | "info" | "log"

export type BridgeResponse = {
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

export type ProgressBeginParams = {
  token: string
  title: string
  message?: string
  percentage?: number
}

export type ProgressReportParams = {
  token: string
  message?: string
  percentage?: number
}

export type ProgressEndParams = {
  token: string
  message?: string
}

export type ApproveParams = {
  title: string
  message?: string
  allow?: string
  deny?: string
  severity?: Severity
}

export type PickParams = {
  title: string
  message?: string
  options: string[]
  severity?: Severity
}

export type BridgeRequestOptions = {
  socket?: string
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

export async function bridgeRequest(
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

export function parsePositiveInteger(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function truncateText(
  value: string | undefined,
  maxLength: number | undefined
): string | undefined {
  if (value === undefined || maxLength === undefined) return value

  const chars = [...value]
  if (chars.length <= maxLength) return value
  if (maxLength === 1) return "…"
  return chars.slice(0, maxLength - 1).join("") + "…"
}

export async function progressBegin(
  params: ProgressBeginParams,
  opt: BridgeRequestOptions = {}
): Promise<void> {
  await bridgeRequest(
    {
      id: `progress-begin-${Date.now()}`,
      type: "progress.begin",
      params,
    },
    opt.socket
  )
}

export async function progressReport(
  params: ProgressReportParams,
  opt: BridgeRequestOptions = {}
): Promise<void> {
  await bridgeRequest(
    {
      id: `progress-report-${Date.now()}`,
      type: "progress.report",
      params,
    },
    opt.socket
  )
}

export async function progressEnd(
  params: ProgressEndParams,
  opt: BridgeRequestOptions = {}
): Promise<void> {
  await bridgeRequest(
    {
      id: `progress-end-${Date.now()}`,
      type: "progress.end",
      params,
    },
    opt.socket
  )
}

const NVIM_CHECKTIME_EXPR =
  "luaeval('vim.schedule(function() pcall(vim.cmd, [[checktime]]) end)')"

export function parentNvimChecktimeCommand(
  env: Record<string, string | undefined> = process.env
): string[] | null {
  const server = env["NVIM"]
  if (!server || server.trim() === "") return null

  return [
    "nvim",
    "--server",
    server,
    "--remote-expr",
    NVIM_CHECKTIME_EXPR,
  ]
}

async function runCommand(argv: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: argv,
    stdout: "ignore",
    stderr: "ignore",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`command failed with exit code ${exitCode}`)
  }
}

export async function maybeChecktimeParentNvim(
  env: Record<string, string | undefined> = process.env,
  run: (argv: string[]) => Promise<void> = runCommand
): Promise<boolean> {
  const argv = parentNvimChecktimeCommand(env)
  if (!argv) return false
  await run(argv)
  return true
}

export async function approve(
  params: ApproveParams,
  opt: BridgeRequestOptions = {}
): Promise<boolean> {
  const response = await bridgeRequest(
    {
      id: `approve-${Date.now()}`,
      type: "query.confirm",
      params,
    },
    opt.socket
  )

  return response.result?.approved === true
}

export async function pick(
  params: PickParams,
  opt: BridgeRequestOptions = {}
): Promise<string | null> {
  const response = await bridgeRequest(
    {
      id: `pick-${Date.now()}`,
      type: "query.pick",
      params,
    },
    opt.socket
  )

  return typeof response.result?.choice === "string"
    ? response.result.choice
    : null
}
