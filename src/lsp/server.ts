import type {
  InitializeParams, InitializeResult,
  DidOpenTextDocumentParams, DidChangeTextDocumentParams,
  DidCloseTextDocumentParams, CompletionParams,
  DefinitionParams, Location,
  DocumentSymbolParams, FoldingRangeParams,
} from "vscode-languageserver"
import {
  createConnection, ProposedFeatures, TextDocumentSyncKind
} from "vscode-languageserver/node"
import type { MessageReader, MessageWriter } from "vscode-jsonrpc"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { buildDiagnostics } from "./diagnostics"
import { dirname } from "path"
import { computeCompletions } from "./completions"
import { buildDocumentSymbols } from "./symbols"

import { buildFoldingRanges } from "./folding"

type Doc = { uri: string, text: string }

const docs = new Map<string, Doc>()
const diagTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleDiagnostics(
  connection: ReturnType<typeof createConnection>,
  uriStr: string,
  debounce_ms : number
) {
  const prev = diagTimers.get(uriStr)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(async () => {
    try {
      const u = new URL(uriStr)
      const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
      const text = docs.get(uriStr)?.text ?? ""
      const diagnostics = await buildDiagnostics(text, docDir)
      connection.sendDiagnostics({ uri: uriStr, diagnostics })
    } catch {
      // ignore
    } finally {
      diagTimers.delete(uriStr)
    }
  }, debounce_ms)
  diagTimers.set(uriStr, timer)
}

export function registerLspHandlers(connection: ReturnType<typeof createConnection>) {
  connection.onInitialize((_params: InitializeParams)
    : InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: [":", "["]
        },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        foldingRangeProvider: true,
      }
    }
  })

  connection.onDidOpenTextDocument(async (ev: DidOpenTextDocumentParams) => {
    docs.set(ev.textDocument.uri, {
      uri: ev.textDocument.uri,
      text: ev.textDocument.text
    })
    // Publish diagnostics on open (zero debounce so initial state is visible)
    scheduleDiagnostics(connection, ev.textDocument.uri, 0)
  })

  connection.onDidChangeTextDocument(async (ev: DidChangeTextDocumentParams) => {
    const uri = ev.textDocument.uri
    const changes = ev.contentChanges
    const last = changes[changes.length - 1]
    if (!last) return
    const cur = docs.get(uri)
    if (!cur) {
      docs.set(uri, { uri, text: last.text })
    } else {
      cur.text = last.text
    }
    // Debounced diagnostics to reduce churn during streaming
    scheduleDiagnostics(connection, uri, 120)
  })

  connection.onDidCloseTextDocument((ev: DidCloseTextDocumentParams) => {
    docs.delete(ev.textDocument.uri)
  })

  connection.onDefinition(async (params: DefinitionParams): Promise<Location[] | null> => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null
    const { resolveDefinition } = await import('./definitions')
    return await resolveDefinition(params.textDocument.uri, doc.text, params.position)
  })

  connection.onCompletion(async (params: CompletionParams) => {
    const uri = new URL(params.textDocument.uri)
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null

    const docDir = uri.protocol === "file:" ? dirname(uri.pathname) : undefined

    return await computeCompletions(
      params.textDocument.uri,
      doc.text,
      params.position,
      docDir
    )
  })

  connection.onDocumentSymbol(async (params: DocumentSymbolParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    return buildDocumentSymbols(doc.text)
  })

  connection.onHover(async (params: any) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null
    const u = new URL(params.textDocument.uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
    const { computeHover } = await import('./hovers')
    return await computeHover(doc.text, params.position, docDir)
  })

  connection.onFoldingRanges(async (params: FoldingRangeParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    return await buildFoldingRanges(doc.text)
  })
}

export async function startLsp() {
  const connection = createConnection(
    new StreamMessageReader(process.stdin as unknown as NodeJS.ReadableStream),
    new StreamMessageWriter(process.stdout as unknown as NodeJS.WritableStream),
    ProposedFeatures.all
  )
  registerLspHandlers(connection)
  connection.listen()
}

export function startLspWithStreams(reader: MessageReader, writer: MessageWriter) {
  const connection = createConnection(reader, writer, ProposedFeatures.all)
  registerLspHandlers(connection)
  connection.listen()
  return connection
}
