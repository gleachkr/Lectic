/// <reference lib="webworker" />
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { buildDiagnostics } from "./diagnostics"
import { buildFoldingRangesFromAst } from "./folding"
import type {
  FoldResult,
  DiagnosticsResult,
  WorkerMessage
} from "./analysisTypes"

// Bun's Worker uses the web worker API. We listen for messages and
// post results back to the parent. We do not retain any global state.

self.addEventListener("message", async (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data
  if (msg.type !== "analyze") return
  try {
    // Single parse shared by folding and diagnostics
    const ast = remark().use(remarkDirective).parse(msg.text)

    // 1) Folds first
    try {
      const folding = buildFoldingRangesFromAst(ast, msg.text)
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

    // 2) Diagnostics second
    try {
      const diagnostics = await buildDiagnostics(ast, msg.text, msg.docDir)
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
    // Total parse failure: send empty fold and empty diagnostics
    const foldMsg: FoldResult = {
      type: "fold",
      uri: msg.uri,
      version: msg.version,
      folding: [],
    }
    self.postMessage(foldMsg)
    const diagMsg: DiagnosticsResult = {
      type: "diagnostics",
      uri: msg.uri,
      version: msg.version,
      diagnostics: [],
    }
    self.postMessage(diagMsg)
  }
})
