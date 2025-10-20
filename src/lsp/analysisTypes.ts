import type { Diagnostic, FoldingRange } from "vscode-languageserver"

// Compact, document-relative analysis bundle that avoids repeated AST walks.
export type DirectiveSpan = {
  key: string
  absStart: number
  absEnd: number
  innerStart: number
  innerEnd: number
}

export type LinkSpan = {
  absStart: number
  absEnd: number
  urlStart: number
  urlEnd: number
}

export type BlockSpan = {
  kind: 'assistant' | 'user'
  absStart: number
  absEnd: number
  name?: string
}


export type ToolCallBlockSpan = {
  absStart: number
  absEnd: number
}

export type AnalysisBundle = {
  uri: string
  version: number
  headerOffset: number
  directives: DirectiveSpan[]
  links: LinkSpan[]
  blocks: BlockSpan[]
  toolCallBlocks: ToolCallBlockSpan[]
}

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

export type BundleResult = {
  type: "bundle"
  uri: string
  version: number
  bundle: AnalysisBundle
}

export type WorkerMessage =
  | AnalyzeRequest
  | FoldResult
  | DiagnosticsResult
  | BundleResult
