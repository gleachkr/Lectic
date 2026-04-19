import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createConnection as createNetConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "stream"
import { createMessageConnection } from "vscode-jsonrpc"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

import { editorBridgeSocketPath } from "./editorBridge"
import { startLspWithStreams } from "./server"

async function requestBridge(
  socketPath: string,
  request: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
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
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      finish(() => resolve(JSON.parse(line)))
    })
    socket.once("error", (error) => finish(() => reject(error)))
  })
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 250
): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for editor bridge event")
    }
    await Bun.sleep(5)
  }
}

describe("LSP editor bridge", () => {
  test("forwards progress notifications to the LSP client", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-lsp-bridge-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-lsp-bridge-root-"))

    try {
      const c2s = new PassThrough()
      const s2c = new PassThrough()

      startLspWithStreams(
        new StreamMessageReader(c2s),
        new StreamMessageWriter(s2c),
        {
          enableEditorBridge: true,
          editorBridgeStateDir: stateDir,
        }
      )

      const client = createMessageConnection(
        new StreamMessageReader(s2c),
        new StreamMessageWriter(c2s)
      )
      const created: unknown[] = []
      const progress: unknown[] = []

      client.onRequest("window/workDoneProgress/create", (params) => {
        created.push(params)
        return null
      })
      client.onNotification("$/progress", (params) => {
        progress.push(params)
      })
      client.listen()

      await client.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "test" },
        rootUri: `file://${workspaceRoot}`,
        capabilities: {
          window: {
            workDoneProgress: true,
          },
        },
      })

      const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)
      const response = await requestBridge(socketPath, {
        id: "progress-1",
        type: "progress.begin",
        params: {
          token: "tok-1",
          title: "Running tests",
          message: "eslint",
          percentage: 25,
        },
      }) as { ok: boolean }

      await waitFor(() => created.length === 1 && progress.length === 1)

      expect(response.ok).toBe(true)
      expect(created).toEqual([{ token: "tok-1" }])
      expect(progress).toEqual([
        {
          token: "tok-1",
          value: {
            kind: "begin",
            title: "Running tests",
            message: "eslint",
            percentage: 25,
            cancellable: undefined,
          },
        },
      ])

      client.dispose()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("queues progress end that arrives before begin", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-lsp-race-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-lsp-race-root-"))

    try {
      const c2s = new PassThrough()
      const s2c = new PassThrough()

      startLspWithStreams(
        new StreamMessageReader(c2s),
        new StreamMessageWriter(s2c),
        {
          enableEditorBridge: true,
          editorBridgeStateDir: stateDir,
        }
      )

      const client = createMessageConnection(
        new StreamMessageReader(s2c),
        new StreamMessageWriter(c2s)
      )
      const created: unknown[] = []
      const progress: unknown[] = []

      client.onRequest("window/workDoneProgress/create", (params) => {
        created.push(params)
        return null
      })
      client.onNotification("$/progress", (params) => {
        progress.push(params)
      })
      client.listen()

      await client.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "test" },
        rootUri: `file://${workspaceRoot}`,
        capabilities: {
          window: {
            workDoneProgress: true,
          },
        },
      })

      const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)
      const endResponse = await requestBridge(socketPath, {
        id: "progress-end-1",
        type: "progress.end",
        params: {
          token: "tok-race",
          message: "Done",
        },
      }) as { ok: boolean }

      expect(endResponse.ok).toBe(true)
      expect(created).toEqual([])
      expect(progress).toEqual([])

      const beginResponse = await requestBridge(socketPath, {
        id: "progress-begin-1",
        type: "progress.begin",
        params: {
          token: "tok-race",
          title: "Running tests",
          message: "eslint",
        },
      }) as { ok: boolean }

      await waitFor(() => created.length === 1 && progress.length === 2)

      expect(beginResponse.ok).toBe(true)
      expect(created).toEqual([{ token: "tok-race" }])
      expect(progress).toEqual([
        {
          token: "tok-race",
          value: {
            kind: "begin",
            title: "Running tests",
            message: "eslint",
            percentage: undefined,
            cancellable: undefined,
          },
        },
        {
          token: "tok-race",
          value: {
            kind: "end",
            message: "Done",
          },
        },
      ])

      client.dispose()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("queues progress report that arrives before begin", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-lsp-race-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-lsp-race-root-"))

    try {
      const c2s = new PassThrough()
      const s2c = new PassThrough()

      startLspWithStreams(
        new StreamMessageReader(c2s),
        new StreamMessageWriter(s2c),
        {
          enableEditorBridge: true,
          editorBridgeStateDir: stateDir,
        }
      )

      const client = createMessageConnection(
        new StreamMessageReader(s2c),
        new StreamMessageWriter(c2s)
      )
      const created: unknown[] = []
      const progress: unknown[] = []

      client.onRequest("window/workDoneProgress/create", (params) => {
        created.push(params)
        return null
      })
      client.onNotification("$/progress", (params) => {
        progress.push(params)
      })
      client.listen()

      await client.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "test" },
        rootUri: `file://${workspaceRoot}`,
        capabilities: {
          window: {
            workDoneProgress: true,
          },
        },
      })

      const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)
      const reportResponse = await requestBridge(socketPath, {
        id: "progress-report-1",
        type: "progress.report",
        params: {
          token: "tok-race",
          message: "Almost done",
          percentage: 80,
        },
      }) as { ok: boolean }

      expect(reportResponse.ok).toBe(true)
      expect(created).toEqual([])
      expect(progress).toEqual([])

      const beginResponse = await requestBridge(socketPath, {
        id: "progress-begin-2",
        type: "progress.begin",
        params: {
          token: "tok-race",
          title: "Running tests",
          message: "eslint",
        },
      }) as { ok: boolean }

      await waitFor(() => created.length === 1 && progress.length === 2)

      expect(beginResponse.ok).toBe(true)
      expect(created).toEqual([{ token: "tok-race" }])
      expect(progress).toEqual([
        {
          token: "tok-race",
          value: {
            kind: "begin",
            title: "Running tests",
            message: "eslint",
            percentage: undefined,
            cancellable: undefined,
          },
        },
        {
          token: "tok-race",
          value: {
            kind: "report",
            message: "Almost done",
            percentage: 80,
          },
        },
      ])

      client.dispose()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("returns choices from showMessageRequest prompts", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-lsp-pick-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-lsp-pick-root-"))

    try {
      const c2s = new PassThrough()
      const s2c = new PassThrough()

      startLspWithStreams(
        new StreamMessageReader(c2s),
        new StreamMessageWriter(s2c),
        {
          enableEditorBridge: true,
          editorBridgeStateDir: stateDir,
        }
      )

      const client = createMessageConnection(
        new StreamMessageReader(s2c),
        new StreamMessageWriter(c2s)
      )
      const requests: unknown[] = []

      client.onRequest("window/showMessageRequest", (params) => {
        requests.push(params)
        return { title: "Later" }
      })
      client.listen()

      await client.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "test" },
        rootUri: `file://${workspaceRoot}`,
        capabilities: {},
      })

      const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)
      const response = await requestBridge(socketPath, {
        id: "pick-1",
        type: "query.pick",
        params: {
          title: "Run tool now?",
          message: "Choose how to proceed.",
          options: ["Now", "Later", "Never"],
          severity: "warning",
        },
      }) as {
        ok: boolean
        result?: {
          choice?: string | null
        }
      }

      await waitFor(() => requests.length === 1)

      expect(response.ok).toBe(true)
      expect(response.result?.choice).toBe("Later")
      expect(requests).toEqual([
        {
          type: 2,
          message: "Run tool now?\n\nChoose how to proceed.",
          actions: [
            { title: "Now" },
            { title: "Later" },
            { title: "Never" },
          ],
        },
      ])

      client.dispose()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
