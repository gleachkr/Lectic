/// <reference lib="webworker" />
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { buildDiagnostics } from "./diagnostics"
import { buildFoldingRangesFromText } from "./folding"
import { buildBundleFromAst } from "./analysis"
import { splitChunks, hashChunk, shiftPositions, mergeChunkAsts } from "./chunking"
import type { Root } from "mdast"
import type { FoldResult, DiagnosticsResult, WorkerMessage, BundleResult } from "./analysisTypes"

// ── Chunk cache and cooperative cancellation ────────────────────────

const chunkCache = new Map<string, Root>()
let latestVersion = 0

const parser = remark().use(remarkDirective)

async function handleWorkerMessage(
  ev: MessageEvent<WorkerMessage>
): Promise<void> {
  const msg = ev.data
  if (msg.type !== "analyze") return

  // Record this as the latest version for cooperative cancellation
  latestVersion = msg.version

  // 1) Fast-path folds — no AST needed, returns almost instantly
  try {
    const folding = buildFoldingRangesFromText(msg.text)
    const foldMsg: FoldResult = {
      type: "fold",
      uri: msg.uri,
      version: msg.version,
      folding,
    }
    self.postMessage(foldMsg)
  } catch {
    const foldMsg: FoldResult = {
      type: "fold",
      uri: msg.uri,
      version: msg.version,
      folding: [],
    }
    self.postMessage(foldMsg)
  }

  // 2) Chunked AST parse for bundle and diagnostics
  try {
    const chunks = splitChunks(msg.text)
    const shifted: Root[] = []

    for (const chunk of chunks) {
      // Cooperative cancellation: bail if a newer request arrived
      if (latestVersion !== msg.version) return

      const hash = hashChunk(chunk.text)
      let ast = chunkCache.get(hash)
      if (!ast) {
        ast = parser.parse(chunk.text)
        chunkCache.set(hash, ast)
      }
      shifted.push(shiftPositions(ast, chunk.offset, chunk.lineOffset))
    }

    // Final staleness check before merging
    if (latestVersion !== msg.version) return

    const combinedAst = mergeChunkAsts(shifted)

    // Bundle
    try {
      const bundle = buildBundleFromAst(combinedAst, msg.text, msg.uri, msg.version)
      const bundleMsg: BundleResult = {
        type: "bundle",
        uri: msg.uri,
        version: msg.version,
        bundle,
      }
      self.postMessage(bundleMsg)
    } catch {
      // Ignore bundle errors; callers will wait for next analysis
    }

    // Diagnostics
    try {
      const diagnostics = await buildDiagnostics(combinedAst, msg.text, msg.docDir)
      const diagMsg: DiagnosticsResult = {
        type: "diagnostics",
        uri: msg.uri,
        version: msg.version,
        diagnostics,
      }
      self.postMessage(diagMsg)
    } catch {
      const diagMsg: DiagnosticsResult = {
        type: "diagnostics",
        uri: msg.uri,
        version: msg.version,
        diagnostics: [],
      }
      self.postMessage(diagMsg)
    }
  } catch {
    // Total parse failure: send empty diagnostics
    const diagMsg: DiagnosticsResult = {
      type: "diagnostics",
      uri: msg.uri,
      version: msg.version,
      diagnostics: [],
    }
    self.postMessage(diagMsg)
  }
}

self.addEventListener("message", (ev: MessageEvent<WorkerMessage>) => {
  void handleWorkerMessage(ev)
})
