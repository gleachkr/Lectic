import { describe, test, expect } from "bun:test"
import { PassThrough } from "stream"
import { StreamMessageReader, StreamMessageWriter }
  from "vscode-jsonrpc/node"
import { createMessageConnection } from "vscode-jsonrpc"
import { startLspWithStreams } from "./server"

async function collect<T>(p: Promise<T>) { return await p }

describe("LSP integration", () => {
  test("completion on ':' includes directive snippets", async () => {
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
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
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

    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("cmd")).toBeTrue()
    expect(labels.has("env")).toBeTrue()
    expect(labels.has("verbatim")).toBeTrue()
    expect(labels.has("once")).toBeTrue()
    expect(labels.has("discard")).toBeTrue()
    expect(labels.has("attach")).toBeTrue()
    expect(labels.has("reset")).toBeTrue()
    expect(labels.has("ask")).toBeTrue()
    expect(labels.has("aside")).toBeTrue()
    expect(labels.has("macro")).toBeFalse()

    const cmdItem = items.find((x: any) => x.label === "cmd")
    expect(cmdItem.textEdit.newText).toBe(":cmd[${0:command}]")

    client.dispose()
  })

  test("prefix filter and replacement span for directives", async () => {
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

    // Type ":as" and ask for completion
    const text = `---\n---\nBody\n:as`;
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const posChar = 3 // after ":as"
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: posChar } }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])

    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("ask")).toBeTrue()
    expect(labels.has("aside")).toBeTrue()

    const one = items.find((x: any) => x.label === "ask")
    // Replace starts at the ':' and ends at after 'as'
    expect(one.textEdit.range.start.character).toBe(0)
    expect(one.textEdit.range.end.character).toBe(posChar)

    client.dispose()
  })

  test("does not suggest macros inside legacy :macro[...] brackets", async () => {
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

    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hello\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./plan.txt\n---\nBody\n:macro[su]`;
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const lineText = text.split(/\r?\n/)[line]
    const posChar = lineText.length // end of line after 'su]'
    // Cursor between 'u' and ']' (simulate inside brackets)
    const innerPosChar = posChar - 1
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: innerPosChar } }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])
    const labels = new Set(items.map((x: any) => x.label))
    // With Phase 4 complete, :macro[...] is not special, so no macro
    // completion should happen inside its brackets.
    expect(labels.has("summarize")).toBeFalse()
    expect(labels.has("Boggle")).toBeFalse()

    const one = items.find((x: any) => x.label === "summarize")
    expect(one).toBeUndefined()

    client.dispose()
  })

  test("inside brackets: :ask[...] suggests interlocutors (and macros)", async () => {
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

    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hello\n  - name: Oggle\n    prompt: hi\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nBody\n:ask[Bo]`;
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const line = text.split(/\r?\n/).length - 1
    const lineText = text.split(/\r?\n/)[line]
    const posChar = lineText.length // after ']'
    const innerPosChar = posChar - 1
    const result: any = await collect(client.sendRequest(
      "textDocument/completion",
      { textDocument: { uri }, position: { line, character: innerPosChar } }
    ))

    const items = Array.isArray(result) ? result : (result?.items ?? [])
    const labels = new Set(items.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    // Only names matching the typed prefix should appear
    expect(labels.has("summarize")).toBeFalse()

    client.dispose()
  })

  test("macro directive completion prefers new syntax", async () => {
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

    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nBody\n:su`;
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
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
    const one = items.find((x: any) => x.label === "summarize")
    expect(Boolean(one)).toBeTrue()
    expect(one.textEdit.newText).toBe(":summarize[]$0")

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
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
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

  test("document symbols provide header and body outline", async () => {
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

    const text = `---\ninterlocutors:\n  - name: Oggle\n    prompt: hi\nmacros:\n  - name: summarize\n    expansion: exec:echo\n---\nText\n\n:::Oggle\nhi\n:::\n`;
    const path = "/tmp/test-doc.lec"
    const uri = `file://${path}`
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "markdown", version: 1, text }
    })

    const result: any = await collect(client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } }
    ))

    // Expect DocumentSymbol[]
    expect(Array.isArray(result)).toBeTrue()
    const names: string[] = []
    const walk = (xs: any[]) => xs.forEach(s => {
      names.push(String(s.name))
      if (Array.isArray(s.children)) walk(s.children)
    })
    walk(result)
    expect(names.includes("Header")).toBeTrue()
    expect(names.includes("Interlocutors")).toBeTrue()
    expect(names.includes("Macros")).toBeTrue()
    expect(names.includes("Oggle")).toBeTrue()
    expect(names.includes("summarize")).toBeTrue()
    expect(names.includes("Body")).toBeTrue()
    expect(names.some(n => n.startsWith("Oggle:"))).toBeTrue()

    client.dispose()
  })
})
