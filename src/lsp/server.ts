import type {
  InitializeParams, InitializeResult,
  DidOpenTextDocumentParams, DidChangeTextDocumentParams,
  DidCloseTextDocumentParams, CompletionParams,
  DefinitionParams, Location,
  DocumentSymbolParams, FoldingRangeParams,
  WorkspaceSymbolParams, CodeActionParams
} from "vscode-languageserver"
import {
  createConnection, ProposedFeatures, TextDocumentSyncKind
} from "vscode-languageserver/node"
import type { MessageReader, MessageWriter } from "vscode-jsonrpc"
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { dirname } from "path"
import { computeCompletions } from "./completions"
import { buildDocumentSymbols } from "./symbols"
import { buildWorkspaceSymbols } from "./workspaceSymbols"
import { computeCodeActions } from "./codeActions"
import type { AnalyzeRequest, FoldResult, DiagnosticsResult } from "./analysisTypes"
import type { FoldingRange } from "vscode-languageserver"

// Minimal document record (track text and client-provided version)
type Doc = { uri: string, text: string, version: number }

type FoldWaiter = (v: FoldingRange[]) => void

const docs = new Map<string, Doc>()

function isFoldResult(m: unknown): m is FoldResult {
  return !!m && typeof (m as any).type === 'string' && (m as any).type === 'fold'
}
function isDiagnosticsResult(m: unknown): m is DiagnosticsResult {
  return !!m && typeof (m as any).type === 'string' && (m as any).type === 'diagnostics'
}

// Coordinator per document. It owns a worker and the last results.
class DocumentAnalyzer {
  private worker: Worker | null = null
  private inflight: Promise<void> | null = null
  private resolver: (() => void) | null = null
  private rejecter: ((e: unknown) => void) | null = null
  private cachedFolding: FoldResult | null = null
  private currentVersion = 0
  private pending: AnalyzeRequest | null = null
  private foldingWaiters: FoldWaiter[] = []

  constructor(private uri: string,
              private connection: ReturnType<typeof createConnection>) {}

  private ensureWorker() {
    if (this.worker) return
    // Bun quirk: use full relative path and type: 'module'
    this.worker = new Worker('./src/lsp/parserWorker.ts', {
      type: 'module'
    })

    this.worker.addEventListener('message', (ev: MessageEvent<FoldResult | DiagnosticsResult>) => {
      const m = ev.data
      if (!m || m.uri !== this.uri) return

      // Folding result arrives first
      if (isFoldResult(m)) {
        if (m.version === this.currentVersion) {
          // Cache only when stable (no pending next analysis)
          if (!this.pending) {
            this.cachedFolding = m
            // Satisfy any waiters
            const fs = this.cachedFolding.folding
            const waiters = this.foldingWaiters
            this.foldingWaiters = []
            for (const w of waiters) w(fs)
          }
        }
        return
      }

      // Diagnostics arrive second
      if (isDiagnosticsResult(m)) {
        if (m.version === this.currentVersion) {
          this.connection.sendDiagnostics({ uri: this.uri, diagnostics: m.diagnostics })
        }
        // Resolve the inflight task after diagnostics to allow request
        // chaining (fold then diagnostics constitutes one analysis unit).
        if (this.resolver) {
          const resolve = this.resolver
          this.resolver = null
          this.rejecter = null
          this.inflight = null
          resolve()
        }
        // Dispatch pending after completing this analysis unit
        if (this.pending) {
          const next = this.pending
          this.pending = null
          this.inflight = new Promise<void>((resolve, reject) => {
            this.resolver = resolve
            this.rejecter = reject
          })
          this.worker!.postMessage(next)
        }
      }
    })

    this.worker.addEventListener('error', () => {
      if (this.rejecter) {
        const rej = this.rejecter
        this.resolver = null
        this.rejecter = null
        this.inflight = null
        rej(new Error('worker error'))
      }
      // Keep the worker; avoid terminate loops that can trigger segfaults.
      // A fresh request will continue to use the same worker instance.
    })
  }

  private disposeWorker() {
    if (this.worker) {
      try { this.worker.terminate() } catch { /* ignore */ }
    }
    this.worker = null
  }



  async requestAnalyze(text: string, version: number, docDir?: string) {
    this.currentVersion = version
    this.ensureWorker()
    const req: AnalyzeRequest = {
      type: 'analyze',
      uri: this.uri,
      version,
      text,
      docDir,
    }
    // Clear cached folding on any new edit
    this.cachedFolding = null
    if (this.inflight) {
      // Latest-only: remember only the most recent pending request
      this.pending = req
      return
    }
    this.inflight = new Promise<void>((resolve, reject) => {
      this.resolver = resolve
      this.rejecter = reject
    })
    this.worker!.postMessage(req)
  }

  async getFolding(): Promise<import('vscode-languageserver').FoldingRange[]> {
    // Serve cached stable folding if available and current
    if (this.cachedFolding && this.cachedFolding.version === this.currentVersion) {
      return this.cachedFolding.folding
    }
    // Otherwise, wait until a cached version is available
    return await new Promise((resolve) => {
      this.foldingWaiters.push(resolve)
    })
  }

  dispose() {
    this.disposeWorker()
    this.inflight = null
    this.resolver = null
    this.rejecter = null
    this.pending = null
    this.cachedFolding = null
    this.foldingWaiters = []
  }
}

const analyzers = new Map<string, DocumentAnalyzer>()

let workspaceRoots: string[] = []

function extractWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = []
  if (Array.isArray(params.workspaceFolders)) {
    for (const wf of params.workspaceFolders) {
      try {
        const u = new URL(wf.uri)
        if (u.protocol === 'file:') roots.push(dirname(u.pathname))
      } catch { /* ignore */ }
    }
  }
  return roots
}

export function registerLspHandlers(connection: ReturnType<typeof createConnection>) {
  connection.onInitialize((params: InitializeParams)
    : InitializeResult => {
    workspaceRoots = extractWorkspaceRoots(params)
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
        workspaceSymbolProvider: true,
        codeActionProvider: true,
      }
    }
  })

  connection.onDidOpenTextDocument(async (ev: DidOpenTextDocumentParams) => {
    const uri = ev.textDocument.uri
    const version = ev.textDocument.version ?? 1
    const text = ev.textDocument.text
    const rec: Doc = { uri, text, version }
    docs.set(uri, rec)

    const u = new URL(uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined

    let analyzer = analyzers.get(uri)
    if (!analyzer) {
      analyzer = new DocumentAnalyzer(uri, connection)
      analyzers.set(uri, analyzer)
    }
    await analyzer.requestAnalyze(text, version, docDir)
  })

  connection.onDidChangeTextDocument(async (ev: DidChangeTextDocumentParams) => {
    const uri = ev.textDocument.uri
    const last = ev.contentChanges[ev.contentChanges.length - 1]
    if (!last) return
    // Some clients omit version; synthesize a monotonic one
    const prev = docs.get(uri)?.version ?? 1
    const nextVersion = (ev.textDocument.version ?? (prev + 1))

    const cur = docs.get(uri)
    if (!cur) {
      docs.set(uri, { uri, text: last.text, version: nextVersion })
    } else {
      cur.text = last.text
      cur.version = nextVersion
    }

    const u = new URL(uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
    let analyzer = analyzers.get(uri)
    if (!analyzer) {
      analyzer = new DocumentAnalyzer(uri, connection)
      analyzers.set(uri, analyzer)
    }
    await analyzer.requestAnalyze(last.text, nextVersion, docDir)
  })

  connection.onDidCloseTextDocument((ev: DidCloseTextDocumentParams) => {
    const uri = ev.textDocument.uri
    docs.delete(uri)
    const analyzer = analyzers.get(uri)
    if (analyzer) {
      analyzer.dispose()
      analyzers.delete(uri)
    }
    // Clear diagnostics on close
    connection.sendDiagnostics({ uri, diagnostics: [] })
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
    const uri = params.textDocument.uri
    const analyzer = analyzers.get(uri)
    if (!analyzer) return []
    return await analyzer.getFolding()
  })

  connection.onWorkspaceSymbol(async (_params: WorkspaceSymbolParams) => {
    return await buildWorkspaceSymbols(workspaceRoots)
  })

  connection.onCodeAction(async (params: CodeActionParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    const u = new URL(params.textDocument.uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
    const res = await computeCodeActions(params.textDocument.uri, doc.text, params, docDir)
    return res ?? []
  })
}

export async function startLsp() {
  const connection = createConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
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
