import { describe, test, expect } from "bun:test"
import { PassThrough } from "stream"
import { StreamMessageReader, StreamMessageWriter }
  from "vscode-jsonrpc/node"
import { createMessageConnection } from "vscode-jsonrpc"
import { startLspWithStreams } from "./server"

async function collect<T>(p: Promise<T>) { return await p }

describe("LSP integration", () => {
  test("completion on ':' includes macros and inserts :macro[NAME] with simple preview", async () => {
    // Client<->Server streams
    const c2s = new PassThrough()
    const s2c = new PassThrough()

    // Start server on streams
    startLspWithStreams(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c)
    )

    // Create a low-level JSON-RPC client on opposite streams
    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s)
    )
    client.listen()

    // Initialize
    const initResult: any = await collect(client.sendRequest(
      "initialize",
      {
        processId: null,
        clientInfo: { name: "test" },
        rootUri: null,
        capabilities: {}
      }
    ))
    expect(initResult && initResult.capabilities
      && initResult.capabilities.completionProvider
      && Array.isArray(initResult.capabilities.completionProvider.triggerCharacters)
    ).toBeTrue()

    // Open a .lec document with macros and a single ':' on the last line
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./plan.txt\n---\nBody\n:`
    const uri = "/tmp/test-doc.lec"
    client.sendNotification(
      "textDocument/didOpen",
      {
        textDocument: {
          uri,
          languageId: "markdown",
          version: 1,
          text
        }
      }
    )

    // Ask for completion at the ':' (line index last line, char 1)
    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line, character: 1 }
      }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])

    // We should have summarize and plan
    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeTrue()
    expect(labels.has("plan")).toBeTrue()

    // Check one item shape
    const one = items.find((x: any) => x.label === "summarize")
    expect(one.textEdit.newText).toBe(":macro[summarize]")
    expect(String(one.detail)).toBe("summarize")

    client.dispose()
  })

  test("prefix filter and replacement span ", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()

    startLspWithStreams(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c)
    )

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s)
    )
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    // Two macros: summarize and plan. We type ":su" and ask for completion
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./plan.txt\n---\nBody\n:su`;
    const uri = "/tmp/test-doc.lec"
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const posChar = 3 // after ":su"
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: posChar } }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])

    // Only summarize should be suggested
    expect(Array.isArray(items)).toBeTrue()
    expect(items.length >= 1).toBeTrue()
    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeTrue()
    expect(labels.has("plan")).toBeFalse()

    const one = result.find((x: any) => x.label === "summarize")
    expect(one.textEdit.newText).toBe(":macro[summarize]")
    // Replace starts at the ':' and ends at after 'su'
    expect(one.textEdit.range.start.character).toBe(0)
    expect(one.textEdit.range.end.character).toBe(posChar)

    client.dispose()
  })

  test("directive suggestions appear alongside macros", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()

    startLspWithStreams(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c)
    )

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s)
    )
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nBody\n:`
    const uri = "/tmp/test-doc.lec"
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: 1 } }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])
    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("cmd")).toBeTrue()
    expect(labels.has("reset")).toBeTrue()
    expect(labels.has("ask")).toBeTrue()
    expect(labels.has("aside")).toBeTrue()
    expect(labels.has("summarize")).toBeTrue()

    const cmdItem = items.find((x: any) => x.label === "cmd")
    expect(cmdItem.textEdit.newText).toBe(":cmd[${0:command}]")
    const resetItem = items.find((x: any) => x.label === "reset")
    expect(resetItem.textEdit.newText).toBe(":reset[]$0")

    client.dispose()
  })

  test("no completion on '::' fence", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()

    startLspWithStreams(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c)
    )

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s)
    )
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    const text = `---\n---\nBody\n::`;
    const uri = "/tmp/test-doc.lec"
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: 2 } }
    ))
    expect(result === null || result.length === 0).toBeTrue()
    client.dispose()
  })
})
