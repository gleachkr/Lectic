import { describe, test, expect } from "bun:test"
import { PassThrough } from "stream"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { createMessageConnection } from "vscode-jsonrpc"
import { startLspWithStreams } from "./server"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

async function collect<T>(p: Promise<T>) { return await p }

describe("LSP link integrations", () => {
  test("no link target completion (leave to editor)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-link-"))
    try {
      // Create files/dirs
      writeFileSync(join(root, "alpha.txt"), "a")
      mkdirSync(join(root, "sub"))

      const c2s = new PassThrough()
      const s2c = new PassThrough()
      startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
      const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
      client.listen()

      await collect(client.sendRequest("initialize", {
        processId: null, clientInfo: { name: "test" }, rootUri: null, capabilities: {}
      }))

      const doc = `---\n---\nSee [file]()`
      const uri = `file://${join(root, "doc.lec")}`
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version: 1, text: doc }
      })

      const line = 2 // third line
      // Place cursor just after '(' so prefix is empty
      const char = doc.split(/\r?\n/)[line].indexOf("(") + 1
      const result: any = await collect(client.sendRequest("textDocument/completion", {
        textDocument: { uri }, position: { line, character: char }
      }))

      const items = Array.isArray(result) ? result : (result?.items ?? [])
      expect(items.length).toBe(0)

      client.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hover inside link destination shows a small preview for local text", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-link-"))
    try {
      writeFileSync(join(root, "alpha.txt"), "a")

      const c2s = new PassThrough()
      const s2c = new PassThrough()
      startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
      const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
      client.listen()

      await collect(client.sendRequest("initialize", {
        processId: null, clientInfo: { name: "test" }, rootUri: null, capabilities: {}
      }))

      const doc = `---\n---\nSee [file](alpha.txt)`
      const uri = `file://${join(root, "doc.lec")}`
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version: 1, text: doc }
      })

      const line = 2
      const char = doc.split(/\r?\n/)[line].indexOf("(alpha.txt") + 2
      const hover: any = await collect(client.sendRequest("textDocument/hover", {
        textDocument: { uri }, position: { line, character: char }
      }))

      const md = String(hover?.contents?.value || "")
      expect(md.includes("Path: ")).toBeTrue()
      expect(md.includes("```")).toBeTrue()
      expect(md.includes("a")).toBeTrue()

      client.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hover with file://$PWD expands and previews", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-link-"))
    const stashed_pwd = process.env["PWD"]
    process.env["PWD"] = root
    try {
      writeFileSync(join(root, "env.txt"), "ENV")

      const c2s = new PassThrough()
      const s2c = new PassThrough()
      startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
      const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
      client.listen()

      await collect(client.sendRequest("initialize", {
        processId: null, clientInfo: { name: "test" }, rootUri: null, capabilities: {}
      }))

      const doc = `---\n---\nSee [file](file://$PWD/env.txt)`
      const uri = `file://${join(root, "doc.lec")}`
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version: 1, text: doc }
      })


      const line = 2
      const char = doc.split(/\r?\n/)[line].indexOf("(file://$PWD/env.txt") + 10
      const hover: any = await collect(client.sendRequest("textDocument/hover", {
        textDocument: { uri }, position: { line, character: char }
      }))

      const md = String(hover?.contents?.value || "")
      expect(md.includes("ENV")).toBeTrue()

      client.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
      process.env["PWD"] = stashed_pwd
    }
  })

  test("hover on directory shows no preview: directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-link-"))
    try {
      mkdirSync(join(root, "sub"))

      const c2s = new PassThrough()
      const s2c = new PassThrough()
      startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
      const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
      client.listen()

      await collect(client.sendRequest("initialize", {
        processId: null, clientInfo: { name: "test" }, rootUri: null, capabilities: {}
      }))

      const doc = `---\n---\nSee [dir](sub/)`
      const uri = `file://${join(root, "doc.lec")}`
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version: 1, text: doc }
      })

      const line = 2
      const char = doc.split(/\r?\n/)[line].indexOf("(sub/") + 2
      const hover: any = await collect(client.sendRequest("textDocument/hover", {
        textDocument: { uri }, position: { line, character: char }
      }))

      const md = String(hover?.contents?.value || "")
      expect(md.includes("No preview: directory")).toBeTrue()

      client.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hover on glob shows truncated list with total count", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-link-"))
    try {
      for (let i = 0; i < 25; i++) writeFileSync(join(root, `f${i}.txt`), String(i))

      const c2s = new PassThrough()
      const s2c = new PassThrough()
      startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
      const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
      client.listen()

      await collect(client.sendRequest("initialize", {
        processId: null, clientInfo: { name: "test" }, rootUri: null, capabilities: {}
      }))

      const doc = `---\n---\nSee [glob](*.txt)`
      const uri = `file://${join(root, "doc.lec")}`
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "markdown", version: 1, text: doc }
      })

      const line = 2
      const char = doc.split(/\r?\n/)[line].indexOf("(*.txt") + 2
      const hover: any = await collect(client.sendRequest("textDocument/hover", {
        textDocument: { uri }, position: { line, character: char }
      }))

      const md = String(hover?.contents?.value || "")
      expect(md.includes("truncated")).toBeTrue()
      expect(md.includes("25")).toBeTrue()

      client.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
