import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  createConnection as createNetConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"

import { Logger } from "../logging/logger"
import { lecticStateDir } from "../utils/xdg"

export type EditorBridgeSeverity = "error" | "warning" | "info" | "log"

export type EditorBridgeRequest =
  | {
      id?: string
      type: "progress.begin"
      params: {
        token: string
        title: string
        message?: string
        percentage?: number
        cancellable?: boolean
      }
    }
  | {
      id?: string
      type: "progress.report"
      params: {
        token: string
        message?: string
        percentage?: number
      }
    }
  | {
      id?: string
      type: "progress.end"
      params: {
        token: string
        message?: string
      }
    }
  | {
      id: string
      type: "query.pick"
      params: {
        title: string
        message?: string
        options: string[]
        severity?: EditorBridgeSeverity
      }
    }
  | {
      id: string
      type: "query.confirm"
      params: {
        title: string
        message?: string
        allow?: string
        deny?: string
        severity?: EditorBridgeSeverity
      }
    }

export type EditorBridgeResponse =
  | {
      id: string
      ok: true
      result?: unknown
    }
  | {
      id: string
      ok: false
      error: {
        code: string
        message: string
      }
    }

type LspBridgeConnection = {
  sendRequest(method: string, params?: unknown): Promise<unknown>
  sendNotification(method: string, params?: unknown): Promise<void> | void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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

export function editorBridgeSocketPath(
  root: string,
  stateDir: string = lecticStateDir()
): string {
  const hash = socketHash(root)
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lectic-editor-${hash}`
  }
  return join(stateDir, "lsp", `editor-${hash}.sock`)
}

export function editorBridgeCandidateRoots(startDir: string): string[] {
  const roots: string[] = []
  let current = normalizeRoot(startDir)

  for (;;) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) return roots
    current = parent
  }
}

function messageType(severity: EditorBridgeSeverity | undefined): number {
  switch (severity) {
    case "error":
      return 1
    case "warning":
      return 2
    case "log":
      return 4
    case "info":
    default:
      return 3
  }
}

function formatPromptMessage(title: string, message: string | undefined): string {
  const trimmedTitle = title.trim()
  const trimmedMessage = message?.trim()
  if (!trimmedMessage) return trimmedTitle
  if (!trimmedTitle) return trimmedMessage
  return `${trimmedTitle}\n\n${trimmedMessage}`
}

async function canConnectToSocket(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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

async function listenOnServer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function invalidRequest(
  id: string | undefined,
  message: string
): EditorBridgeResponse | null {
  if (!id) return null
  return {
    id,
    ok: false,
    error: {
      code: "invalid_request",
      message,
    },
  }
}

function success(id: string | undefined, result?: unknown): EditorBridgeResponse | null {
  if (!id) return null
  return { id, ok: true, result }
}

function failure(
  id: string | undefined,
  code: string,
  message: string
): EditorBridgeResponse | null {
  if (!id) return null
  return {
    id,
    ok: false,
    error: { code, message },
  }
}

function parseString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

function parseOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`)
  }
  return value
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function parseSeverity(value: unknown): EditorBridgeSeverity | undefined {
  if (value === undefined) return undefined
  if (
    value === "error" ||
    value === "warning" ||
    value === "info" ||
    value === "log"
  ) {
    return value
  }
  throw new Error("severity must be one of: error, warning, info, log")
}

type PendingProgressState = {
  report?: {
    message?: string
    percentage?: number
  }
  end?: {
    message?: string
  }
}

class EditorBridgeHandler {
  private progressTokens = new Set<string>()
  private pendingProgress = new Map<string, PendingProgressState>()

  constructor(
    private connection: LspBridgeConnection,
    private supportsWorkDoneProgress: () => boolean
  ) {}

  async handleLine(line: string): Promise<EditorBridgeResponse | null> {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return null
    }

    if (!isRecord(raw)) return null

    const id = typeof raw["id"] === "string" ? raw["id"] : undefined
    const type = raw["type"]
    if (typeof type !== "string") {
      return invalidRequest(id, "type must be a string")
    }

    const params = isRecord(raw["params"]) ? raw["params"] : {}

    try {
      switch (type) {
        case "progress.begin": {
          const token = parseString(params["token"], "params.token")
          const title = parseString(params["title"], "params.title")
          const message = parseOptionalString(
            params["message"],
            "params.message"
          )
          const percentage = parseOptionalNumber(
            params["percentage"],
            "params.percentage"
          )
          const cancellable = parseOptionalBoolean(
            params["cancellable"],
            "params.cancellable"
          )
          await this.progressBegin({
            token,
            title,
            message,
            percentage,
            cancellable,
          })
          return success(id)
        }
        case "progress.report": {
          const token = parseString(params["token"], "params.token")
          const message = parseOptionalString(
            params["message"],
            "params.message"
          )
          const percentage = parseOptionalNumber(
            params["percentage"],
            "params.percentage"
          )
          await this.progressReport({ token, message, percentage })
          return success(id)
        }
        case "progress.end": {
          const token = parseString(params["token"], "params.token")
          const message = parseOptionalString(
            params["message"],
            "params.message"
          )
          await this.progressEnd({ token, message })
          return success(id)
        }
        case "query.pick": {
          if (!id) {
            return invalidRequest(id, "query.pick requires an id")
          }
          const title = parseString(params["title"], "params.title")
          const message = parseOptionalString(
            params["message"],
            "params.message"
          )
          const optionsRaw = params["options"]
          if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
            throw new Error("params.options must be a non-empty string array")
          }
          const options = optionsRaw.map((option, index) => {
            return parseString(option, `params.options[${index}]`)
          })
          const severity = parseSeverity(params["severity"])
          const choice = await this.pick({ title, message, options, severity })
          return success(id, { choice })
        }
        case "query.confirm": {
          if (!id) {
            return invalidRequest(id, "query.confirm requires an id")
          }
          const title = parseString(params["title"], "params.title")
          const message = parseOptionalString(
            params["message"],
            "params.message"
          )
          const allow = parseOptionalString(params["allow"], "params.allow")
          const deny = parseOptionalString(params["deny"], "params.deny")
          const severity = parseSeverity(params["severity"])
          const approved = await this.confirm({
            title,
            message,
            allow,
            deny,
            severity,
          })
          return success(id, { approved })
        }
        default:
          return failure(id, "unknown_type", `unsupported request type: ${type}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(id, "bridge_error", message)
    }
  }

  private pendingState(token: string): PendingProgressState {
    let pending = this.pendingProgress.get(token)
    if (!pending) {
      pending = {}
      this.pendingProgress.set(token, pending)
    }
    return pending
  }

  private async flushPendingProgress(token: string): Promise<void> {
    const pending = this.pendingProgress.get(token)
    if (!pending) return
    this.pendingProgress.delete(token)

    if (pending.report) {
      await this.progressReport({ token, ...pending.report })
    }
    if (pending.end) {
      await this.progressEnd({ token, ...pending.end })
    }
  }

  private async progressBegin(params: {
    token: string
    title: string
    message?: string
    percentage?: number
    cancellable?: boolean
  }): Promise<void> {
    if (!this.supportsWorkDoneProgress()) {
      throw new Error("client does not advertise workDoneProgress support")
    }

    if (!this.progressTokens.has(params.token)) {
      await this.connection.sendRequest("window/workDoneProgress/create", {
        token: params.token,
      })
      this.progressTokens.add(params.token)
    }

    await this.connection.sendNotification("$/progress", {
      token: params.token,
      value: {
        kind: "begin",
        title: params.title,
        message: params.message,
        percentage: params.percentage,
        cancellable: params.cancellable,
      },
    })

    await this.flushPendingProgress(params.token)
  }

  private async progressReport(params: {
    token: string
    message?: string
    percentage?: number
  }): Promise<void> {
    if (!this.progressTokens.has(params.token)) {
      if (this.pendingProgress.get(params.token)?.end) return
      const pending = this.pendingState(params.token)
      pending.report = {
        message: params.message,
        percentage: params.percentage,
      }
      return
    }

    await this.connection.sendNotification("$/progress", {
      token: params.token,
      value: {
        kind: "report",
        message: params.message,
        percentage: params.percentage,
      },
    })
  }

  private async progressEnd(params: {
    token: string
    message?: string
  }): Promise<void> {
    if (!this.progressTokens.has(params.token)) {
      const pending = this.pendingState(params.token)
      pending.end = { message: params.message }
      return
    }

    await this.connection.sendNotification("$/progress", {
      token: params.token,
      value: {
        kind: "end",
        message: params.message,
      },
    })
    this.progressTokens.delete(params.token)
  }

  private async pick(params: {
    title: string
    message?: string
    options: string[]
    severity?: EditorBridgeSeverity
  }): Promise<string | null> {
    const actions = params.options.map((title) => ({ title }))
    const choice = await this.connection.sendRequest("window/showMessageRequest", {
      type: messageType(params.severity),
      message: formatPromptMessage(params.title, params.message),
      actions,
    })

    if (isRecord(choice) && typeof choice["title"] === "string") {
      return choice["title"]
    }
    return null
  }

  private async confirm(params: {
    title: string
    message?: string
    allow?: string
    deny?: string
    severity?: EditorBridgeSeverity
  }): Promise<boolean> {
    const allow = params.allow ?? "Allow"
    const deny = params.deny ?? "Deny"
    const choice = await this.pick({
      title: params.title,
      message: params.message,
      options: [allow, deny],
      severity: params.severity,
    })
    return choice === allow
  }
}

export class EditorBridgeManager {
  private readonly handler: EditorBridgeHandler
  private readonly roots = new Set<string>()
  private readonly servers = new Map<string, Server>()

  constructor(
    connection: LspBridgeConnection,
    private opt: {
      enabled?: boolean
      stateDir?: string
      supportsWorkDoneProgress?: () => boolean
    } = {}
  ) {
    this.handler = new EditorBridgeHandler(
      connection,
      opt.supportsWorkDoneProgress ?? (() => false)
    )
  }

  get enabled(): boolean {
    return this.opt.enabled ?? true
  }

  async ensureRoot(root: string): Promise<void> {
    if (!this.enabled) return

    const normalized = normalizeRoot(root)
    if (this.roots.has(normalized)) return
    this.roots.add(normalized)

    const path = editorBridgeSocketPath(normalized, this.opt.stateDir)
    const server = createServer((socket) => {
      this.handleSocket(socket)
    })

    server.on("error", (error) => {
      Logger.debug("editor bridge socket error", {
        root: normalized,
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    if (process.platform !== "win32") {
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path)) {
        if (await canConnectToSocket(path)) {
          Logger.debug("editor bridge socket already active", {
            root: normalized,
            path,
          })
          server.close()
          return
        }
        rmSync(path, { force: true })
      }
    }

    try {
      await listenOnServer(server, path)
      this.servers.set(normalized, server)
    } catch (error) {
      Logger.debug("failed to start editor bridge", {
        root: normalized,
        path,
        error: error instanceof Error ? error.message : String(error),
      })
      if (process.platform !== "win32" && existsSync(path)) {
        rmSync(path, { force: true })
      }
      server.close()
    }
  }

  async noteDocumentUri(uri: string): Promise<void> {
    if (!this.enabled || this.roots.size > 0) return
    try {
      const parsed = new URL(uri)
      if (parsed.protocol !== "file:") return
      await this.ensureRoot(dirname(parsed.pathname))
    } catch {
      // Ignore malformed URIs.
    }
  }

  async dispose(): Promise<void> {
    const stateDir = this.opt.stateDir
    const closes = [...this.servers.entries()].map(async ([root, server]) => {
      const path = editorBridgeSocketPath(root, stateDir)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      if (process.platform !== "win32") {
        rmSync(path, { force: true })
      }
    })
    await Promise.all(closes)
    this.servers.clear()
    this.roots.clear()
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8")
    let buffer = ""
    let chain = Promise.resolve()

    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === "") continue

        chain = chain
          .then(async () => {
            const response = await this.handler.handleLine(line)
            if (!response) return
            socket.write(JSON.stringify(response) + "\n")
          })
          .catch(() => {
            // Ignore per-request failures after responding.
          })
      }
    })
  }
}
