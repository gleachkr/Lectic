import type { Diagnostic, FoldingRange } from "vscode-languageserver"

export type AnalyzeRequest = {
  type: "analyze"
  uri: string
  version: number
  text: string
  docDir?: string
}

export type FoldResult = {
  type: "fold"
  uri: string
  version: number
  folding: FoldingRange[]
}

export type DiagnosticsResult = {
  type: "diagnostics"
  uri: string
  version: number
  diagnostics: Diagnostic[]
}

export type WorkerMessage =
  | AnalyzeRequest
  | FoldResult
  | DiagnosticsResult
