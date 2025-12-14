import { describe, test, expect } from "bun:test"
import { PassThrough } from "stream"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { createMessageConnection } from "vscode-jsonrpc"
import { startLspWithStreams } from "./server"

async function collect<T>(p: Promise<T>) { return await p }

function openDoc(client: any, uri: string, text: string) {
  client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "markdown", version: 1, text }
  })
}

describe("definitions", () => {
  test("go to definition for :name[] (macro)", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()
    startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
    const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nBody\n:summarize[]`;
    const path = "/tmp/def-macro.lec"
    const uri = `file://${path}`
    openDoc(client, uri, text)

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const char = lines[line].length - 1 // before closing ']'
    const defs: any = await collect(client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line, character: char }
    }))

    expect(Array.isArray(defs)).toBeTrue()
    expect(defs.length).toBeGreaterThan(0)
    const loc = defs[0]
    expect(loc.uri).toBe(uri)
    // Should point inside the YAML header (after the --- line)
    expect(loc.range.start.line).toBeGreaterThan(0)

    client.dispose()
  })

  test("go to definition for :name[] (macro)", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()
    startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
    const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nBody\n:summarize[]`;
    const path = "/tmp/def-macro2.lec"
    const uri = `file://${path}`
    openDoc(client, uri, text)

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const char = lines[line].indexOf(":summarize") + 3

    const defs: any = await collect(client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line, character: char }
    }))

    expect(Array.isArray(defs)).toBeTrue()
    expect(defs.length).toBeGreaterThan(0)
    const loc = defs[0]
    expect(loc.uri).toBe(uri)
    expect(loc.range.start.line).toBeGreaterThan(0)

    client.dispose()
  })

  test("go to definition for :ask[Name]", async () => {
    const c2s = new PassThrough()
    const s2c = new PassThrough()
    startLspWithStreams(new StreamMessageReader(c2s), new StreamMessageWriter(s2c))
    const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s))
    client.listen()

    await collect(client.sendRequest("initialize", {
      processId: null, clientInfo: { name: "test" }, rootUri: null,
      capabilities: {}
    }))

    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hi\n---\nBody\n:ask[Boggle]`;
    const path = "/tmp/def-ask.lec"
    const uri = `file://${path}`
    openDoc(client, uri, text)

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const char = lines[line].length - 1
    const defs: any = await collect(client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line, character: char }
    }))

    expect(Array.isArray(defs)).toBeTrue()
    expect(defs.length).toBeGreaterThan(0)
    const loc = defs[0]
    expect(loc.uri).toBe(uri)
    // Range should be in header (line with name: Boggle)
    expect(loc.range.start.line).toBeGreaterThan(0)

    client.dispose()
  })
})
