import type {
  InitializeParams, InitializeResult,
  DidOpenTextDocumentParams, DidChangeTextDocumentParams,
  DidCloseTextDocumentParams, CompletionParams,
  DefinitionParams, Location,
  DocumentSymbolParams, FoldingRangeParams,
  WorkspaceSymbolParams, CodeActionParams,
  SemanticTokensParams, SemanticTokensRangeParams,
  Diagnostic,
  CodeAction,
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
import { computeCodeActions, resolveCodeAction } from "./codeActions"
import { resolveDefinition } from "./definitions"
import { computeHover } from "./hovers"
import type {
  AnalyzeRequest,
  FoldResult,
  DiagnosticsResult,
  BundleResult,
  AnalysisBundle,
} from "./analysisTypes"
import type { FoldingRange, HoverParams } from "vscode-languageserver"
import { extractWorkspaceRoots } from "./utils/server"
import { buildSemanticTokens, semanticTokenLegend } from "./semanticTokens"
import { initModelRegistry, onModelRegistryUpdate, computeModelDiagnostics } from "./models"
import { EditorBridgeManager } from "./editorBridge"

// Minimal document record (track text and client-provided version)
type Doc = { uri: string, text: string, version: number }

type FoldWaiter = (v: FoldingRange[]) => void
type BundleWaiter = (b: AnalysisBundle) => void

const docs = new Map<string, Doc>()

const hasTypeTag = (m: unknown, tag: string): boolean => {
  if (typeof m !== 'object' || m == null) return false
  const t = (m as Record<string, unknown>)["type"]
  return typeof t === 'string' && t === tag
}
function isFoldResult(m: unknown): m is FoldResult {
  return hasTypeTag(m, 'fold')
}
function isDiagnosticsResult(m: unknown): m is DiagnosticsResult {
  return hasTypeTag(m, 'diagnostics')
}
function isBundleResult(m: unknown): m is BundleResult {
  return hasTypeTag(m, 'bundle')
}

// Coordinator per document. It owns a worker and the last results.
// Uses coalescing: if a new request arrives while one is inflight,
// store it as pending and dispatch after the current one completes.
// The worker uses chunked parsing with cooperative cancellation, so
// stale parses bail quickly without needing terminate-and-respawn.
class DocumentAnalyzer {
  private worker: Worker | null = null
  private inflight: Promise<void> | null = null
  private resolver: (() => void) | null = null
  private rejecter: ((e: unknown) => void) | null = null
  private pending: AnalyzeRequest | null = null
  private cachedFolding: FoldResult | null = null
  private cachedBundle: BundleResult | null = null
  private currentVersion = 0
  private foldingWaiters: FoldWaiter[] = []
  private bundleWaiters: BundleWaiter[] = []

  constructor(private uri: string,
              private connection: ReturnType<typeof createConnection>) {}

  private ensureWorker() {
    if (this.worker) return
    // Resolve worker URL relative to this module; check if we're in production
    // to work around inconsistency with bun worker path resolution
    const workerUrl = process.env.NODE_ENV === "production"
        ? "./lsp/parserWorker.ts"
        : new URL('./parserWorker.ts', import.meta.url).href
    this.worker = new Worker(workerUrl)

    this.worker.addEventListener('message', (ev: MessageEvent<FoldResult | DiagnosticsResult | BundleResult>) => {
      const m = ev.data
      if (!m || m.uri !== this.uri) return

      // Bundle arrives early
      if (isBundleResult(m)) {
        if (!this.pending && m.version === this.currentVersion) {
          this.cachedBundle = m
          const b = this.cachedBundle.bundle
          const waiters = this.bundleWaiters
          this.bundleWaiters = []
          for (const w of waiters) w(b)
        }
        return
      }

      // Folding result arrives first
      if (isFoldResult(m)) {
        if (!this.pending && m.version === this.currentVersion) {
          this.cachedFolding = m
          const waiters = this.foldingWaiters
          this.foldingWaiters = []
          for (const w of waiters) w(m.folding)
        }
        return
      }

      // Diagnostics arrive last — marks analysis unit complete
      if (isDiagnosticsResult(m)) {
        if (!this.pending && m.version === this.currentVersion) {
          // First, forward base diagnostics immediately.
          baseDiagnostics.set(this.uri, m.diagnostics)
          this.connection.sendDiagnostics({ uri: this.uri, diagnostics: m.diagnostics })
          // Then, compute model diagnostics asynchronously and re‑publish.
          const doc = docs.get(this.uri)
          if (doc) {
            const uriNow = this.uri
            const versionNow = this.currentVersion
            const u = new URL(uriNow)
            const dir = u.protocol === 'file:' ? dirname(u.pathname) : undefined
            computeModelDiagnostics(doc.text, dir).then(extra => {
              // Only publish if still current
              if (versionNow === this.currentVersion) {
                const base = baseDiagnostics.get(uriNow) ?? []
                this.connection.sendDiagnostics({ uri: uriNow, diagnostics: [...base, ...extra] })
              }
            }).catch(() => { /* ignore */ })
          }
        }
        // Resolve the inflight task — this analysis unit is complete.
        if (this.resolver) {
          const resolve = this.resolver
          this.resolver = null
          this.rejecter = null
          this.inflight = null
          resolve()
        }
        // Dispatch pending request if one was coalesced
        this.dispatchPending()
      }
    })

    this.worker.addEventListener('error', e => {
      if (this.rejecter) {
        const rej = this.rejecter
        this.resolver = null
        this.rejecter = null
        this.inflight = null
        rej(new Error(`worker error: ${e.message}`))
      }
      this.dispatchPending()
    })
  }

  private dispatchPending() {
    const req = this.pending
    if (!req) return
    this.pending = null
    this.sendRequest(req)
  }

  private sendRequest(req: AnalyzeRequest) {
    this.currentVersion = req.version
    this.cachedFolding = null
    this.cachedBundle = null
    this.ensureWorker()
    this.inflight = new Promise<void>((resolve, reject) => {
      this.resolver = resolve
      this.rejecter = reject
    })
    this.worker!.postMessage(req)
  }

  requestAnalyze(text: string, version: number, docDir?: string) {
    const req: AnalyzeRequest = {
      type: 'analyze',
      uri: this.uri,
      version,
      text,
      docDir,
    }
    if (this.inflight) {
      // A parse is already running. Store as pending — the worker's
      // cooperative cancellation will bail on the stale version, and
      // we'll dispatch this request when the current one completes.
      this.pending = req
      return
    }
    this.sendRequest(req)
  }

  async getFolding(): Promise<FoldingRange[]> {
    // Serve cached stable folding if available and current
    if (this.cachedFolding && !this.pending && this.cachedFolding.version === this.currentVersion) {
      return this.cachedFolding.folding
    }
    // Otherwise, wait until a cached version is available
    return new Promise((resolve) => {
      this.foldingWaiters.push(resolve)
    })
  }

  async getBundle(): Promise<AnalysisBundle> {
    if (this.cachedBundle && !this.pending && this.cachedBundle.version === this.currentVersion) {
      return this.cachedBundle.bundle
    }
    return new Promise((resolve) => {
      this.bundleWaiters.push(resolve)
    })
  }

  dispose() {
    if (this.worker) {
      try { this.worker.terminate() } catch { /* ignore */ }
    }
    this.worker = null
    this.inflight = null
    this.resolver = null
    this.rejecter = null
    this.pending = null
    this.cachedFolding = null
    this.cachedBundle = null
    this.foldingWaiters = []
    this.bundleWaiters = []
  }
}

const analyzers = new Map<string, DocumentAnalyzer>()

// Cache the last diagnostics from the worker per document.
const baseDiagnostics = new Map<string, Diagnostic[]>()

let workspaceRoots: string[] = []

function docDirOf(uri: string): string | undefined {
  try {
    const u = new URL(uri)
    return u.protocol === 'file:' ? dirname(u.pathname) : undefined
  } catch {
    return undefined
  }
}

async function analyzeNow(
  uri: string,
  text: string,
  version: number,
  connection: ReturnType<typeof createConnection>
) {
  let analyzer = analyzers.get(uri)
  if (!analyzer) {
    analyzer = new DocumentAnalyzer(uri, connection)
    analyzers.set(uri, analyzer)
  }
  analyzer.requestAnalyze(text, version, docDirOf(uri))
}

type LspServerOptions = {
  enableEditorBridge?: boolean
  editorBridgeStateDir?: string
}

export function registerLspHandlers(
  connection: ReturnType<typeof createConnection>,
  opt: LspServerOptions = {}
) {
  let clientSupportsWorkDoneProgress = false
  const editorBridge = new EditorBridgeManager(connection, {
    enabled: opt.enableEditorBridge ?? true,
    stateDir: opt.editorBridgeStateDir,
    supportsWorkDoneProgress: () => clientSupportsWorkDoneProgress,
  })

  connection.onInitialize(async (params: InitializeParams)
    : Promise<InitializeResult> => {
    workspaceRoots = extractWorkspaceRoots(params)
    clientSupportsWorkDoneProgress =
      params.capabilities.window?.workDoneProgress === true
    for (const root of workspaceRoots) {
      await editorBridge.ensureRoot(root)
    }
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: [":", "[", "-"]
        },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        foldingRangeProvider: true,
        workspaceSymbolProvider: true,
        codeActionProvider: {
          resolveProvider: true
        },
        semanticTokensProvider: {
          legend: semanticTokenLegend,
          full: true,
          range: true,
        },
      }
    }
  })

  connection.onDidOpenTextDocument(async (ev: DidOpenTextDocumentParams) => {
    const uri = ev.textDocument.uri
    const version = ev.textDocument.version ?? 1
    const text = ev.textDocument.text
    const rec: Doc = { uri, text, version }
    docs.set(uri, rec)

    await editorBridge.noteDocumentUri(uri)
    await analyzeNow(uri, text, version, connection)
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

    await analyzeNow(uri, last.text, nextVersion, connection)
  })

  connection.onDidCloseTextDocument((ev: DidCloseTextDocumentParams) => {
    const uri = ev.textDocument.uri
    docs.delete(uri)
    baseDiagnostics.delete(uri)
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
    return resolveDefinition(params.textDocument.uri, doc.text, params.position)
  })

  connection.onCompletion(async (params: CompletionParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null

    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return null
    const bundle = await analyzer.getBundle()
    return computeCompletions(
      params.textDocument.uri,
      doc.text,
      params.position,
      docDirOf(params.textDocument.uri),
      bundle,
      params.context,
    )
  })

  connection.onDocumentSymbol(async (params: DocumentSymbolParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return []
    const bundle = await analyzer.getBundle()
    return buildDocumentSymbols(doc.text, bundle)
  })

  connection.onHover(async (params: HoverParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null
    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return null
    const bundle = await analyzer.getBundle()
    return computeHover(
      doc.text,
      params.position,
      docDirOf(params.textDocument.uri),
      bundle
    )
  })

  connection.onFoldingRanges(async (params: FoldingRangeParams) => {
    const uri = params.textDocument.uri
    const analyzer = analyzers.get(uri)
    if (!analyzer) return []
    return analyzer.getFolding()
  })

  connection.onWorkspaceSymbol(async (_params: WorkspaceSymbolParams) => {
    return buildWorkspaceSymbols(workspaceRoots)
  })

  connection.onCodeAction(async (params: CodeActionParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return []
    const u = new URL(params.textDocument.uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined
    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return []
    const bundle = await analyzer.getBundle()
    const res = await computeCodeActions(params.textDocument.uri, doc.text, params, docDir, bundle)
    return res ?? []
  })

  connection.onCodeActionResolve(async (action: CodeAction) => {
    // If it's not our action type, return as is
    if (action.data?.type !== 'expand-macro') return action
    
    // We need document text to resolve. We stored uri in data.
    const uri = action.data.uri
    const doc = docs.get(uri)
    if (!doc) return action
    
    const u = new URL(uri)
    const docDir = u.protocol === "file:" ? dirname(u.pathname) : undefined

    return resolveCodeAction(action, doc.text, docDir)
  })

  // Semantic tokens (full and range)
  connection.languages.semanticTokens.on(async (params: SemanticTokensParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return { data: [] }
    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return { data: [] }
    const bundle = await analyzer.getBundle()
    return buildSemanticTokens(doc.text, bundle)
  })

  connection.languages.semanticTokens.onRange(async (params: SemanticTokensRangeParams) => {
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return { data: [] }
    const analyzer = analyzers.get(params.textDocument.uri)
    if (!analyzer) return { data: [] }
    const bundle = await analyzer.getBundle()
    return buildSemanticTokens(doc.text, bundle, params.range)
  })
}

export async function startLsp(opt: LspServerOptions = {}) {
  const connection = createConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
    ProposedFeatures.all
  )

  // Kick off async model discovery without blocking initialization.
  initModelRegistry()

  // When models are discovered/updated, add or update diagnostics.
  onModelRegistryUpdate(() => {
    for (const [uri, doc] of docs.entries()) {
      const base = baseDiagnostics.get(uri) ?? []
      const u = new URL(uri)
      const dir = u.protocol === 'file:' ? dirname(u.pathname) : undefined
      computeModelDiagnostics(doc.text, dir).then(extra => {
        connection.sendDiagnostics({ uri, diagnostics: [...base, ...extra] })
      }).catch(() => { /* ignore */ })
    }
  })

  registerLspHandlers(connection, {
    enableEditorBridge: opt.enableEditorBridge ?? true,
    editorBridgeStateDir: opt.editorBridgeStateDir,
  })
  connection.listen()
}

export function startLspWithStreams(
  reader: MessageReader,
  writer: MessageWriter,
  opt: LspServerOptions = {}
) {
  const connection = createConnection(reader, writer, ProposedFeatures.all)
  registerLspHandlers(connection, {
    enableEditorBridge: opt.enableEditorBridge ?? false,
    editorBridgeStateDir: opt.editorBridgeStateDir,
  })
  connection.listen()
  return connection
}
