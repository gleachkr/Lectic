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


export function registerLspHandlers(connection: ReturnType<typeof createConnection>) {
  connection.onInitialize((_params: InitializeParams)
    : InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: [":", "["]
        },
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
    // Publish diagnostics on open
    try {
      const uri = new URL(ev.textDocument.uri)
      const docDir = uri.protocol === "file:" ? dirname(uri.pathname) : undefined
      const diagnostics = await buildDiagnostics(ev.textDocument.text, docDir)
      connection.sendDiagnostics({ uri: ev.textDocument.uri, diagnostics })
    } catch {
      // ignore
    }
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
    // Publish diagnostics on change (debounce could be added later)
    try {
      const u = new URL(uri)
      const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
      const text = docs.get(uri)?.text ?? last.text
      const diagnostics = await buildDiagnostics(text, docDir)
      connection.sendDiagnostics({ uri, diagnostics })
    } catch {
      // ignore
    }
  })

  connection.onDidCloseTextDocument((ev: DidCloseTextDocumentParams) => {
    docs.delete(ev.textDocument.uri)
  })

  connection.onDefinition(async (params: DefinitionParams): Promise<Location[] | null> => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null
    const { resolveDefinition } = await import('./definitions')
    const locs = await resolveDefinition(params.textDocument.uri, doc.text, params.position)
    return locs
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

  connection.onFoldingRanges(async (params: FoldingRangeParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    const u = new URL(params.textDocument.uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
    return await buildFoldingRanges(doc.text, docDir)
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
