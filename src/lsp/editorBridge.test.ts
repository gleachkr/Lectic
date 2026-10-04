import { describe, expect, test } from "bun:test"
import {
  existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { EditorBridgeManager, editorBridgeRegistryDir } from "./editorBridge"

const connection = {
  sendRequest: async () => null,
  sendNotification: () => {},
}

describe("EditorBridgeManager lifecycle", () => {
  test("disabled bridges create no sockets or registrations", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-disabled-"))
    const bridge = new EditorBridgeManager(connection, {
      enabled: false, stateDir,
    })
    try {
      expect(await bridge.start()).toBeUndefined()
      await bridge.ensureRoot(stateDir)
      expect(bridge.socketPath).toBeUndefined()
      expect(readdirSync(stateDir)).toEqual([])
    } finally {
      await bridge.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("shutdown cleans only its own registrations and open sockets",
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "lectic-lifecycle-"))
      const bridge = new EditorBridgeManager(connection, { stateDir })
      try {
        const [path, samePath] = await Promise.all([
          bridge.start(), bridge.start(),
        ])
        expect(path).toBe(samePath)
        expect(path).toBeDefined()
        await bridge.ensureRoot(stateDir)
        const directory = editorBridgeRegistryDir(stateDir, stateDir)
        expect(readdirSync(directory)).toHaveLength(1)
        const socket = createConnection(path!)
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve)
          socket.once("error", reject)
        })
        // Leave a client connected; shutdown must not wait for it to leave.
        const closed = new Promise<void>((resolve) =>
          socket.once("close", resolve)
        )
        await Promise.all([bridge.dispose(), bridge.dispose()])
        await closed
        expect(readdirSync(directory)).toEqual([])
        expect(bridge.socketPath).toBeUndefined()
        expect(await bridge.start()).toBeUndefined()
        await bridge.ensureRoot(stateDir)
        expect(readdirSync(directory)).toEqual([])
        if (process.platform !== "win32") {
          expect(existsSync(path!)).toBe(false)
        }
      } finally {
        await bridge.dispose()
        rmSync(stateDir, { recursive: true, force: true })
      }
    }
  )

  test("dispose racing with startup leaves no listener", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-start-stop-"))
    const bridge = new EditorBridgeManager(connection, { stateDir })
    try {
      await Promise.all([bridge.ensureRoot(stateDir), bridge.dispose()])
      expect(bridge.socketPath).toBeUndefined()
      expect(readdirSync(join(stateDir, "lsp"))).toEqual([])
    } finally {
      await bridge.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("repeated disposal never unlinks a replacement socket", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-bind-failure-"))
    const bridge = new EditorBridgeManager(connection, { stateDir })
    const path = await bridge.start()
    await bridge.dispose()
    const replacement = createServer((socket) => socket.end())
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once("error", reject)
        replacement.listen(path!, resolve)
      })
      await bridge.dispose()
      if (process.platform !== "win32") {
        expect(existsSync(path!)).toBe(true)
      }
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()))
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})


test("unavailable state storage does not fail LSP initialization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lectic-no-state-"))
  const stateDir = join(directory, "not-a-directory")
  writeFileSync(stateDir, "")
  const bridge = new EditorBridgeManager(connection, { stateDir })
  try {
    expect(await bridge.start()).toBeUndefined()
    await bridge.ensureRoot(directory)
    expect(bridge.socketPath).toBeUndefined()
  } finally {
    await bridge.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a discovery registration failure leaves the private bridge alive",
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-no-registry-"))
    const bridge = new EditorBridgeManager(connection, { stateDir })
    try {
      const path = await bridge.start()
      writeFileSync(join(stateDir, "lsp", "roots"), "")
      await bridge.ensureRoot(stateDir)
      expect(bridge.socketPath).toBe(path)
      const socket = createConnection(path!)
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      socket.destroy()
    } finally {
      await bridge.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
)
