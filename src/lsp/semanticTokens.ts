import type {
  SemanticTokens,
  SemanticTokensLegend,
  Range,
} from "vscode-languageserver"
import type { AnalysisBundle, DirectiveSpan } from "./analysisTypes"
import { offsetToPosition } from "./positions"
import { FENCE_OPEN_RE, FENCE_CLOSE_RE } from "./chunking"

// Legend shared with server initialize
export const semanticTokenLegend: SemanticTokensLegend = {
  tokenTypes: [
    // 0
    "keyword", // use a single, quiet style for all lectic tokens
  ],
  tokenModifiers: [],
}

// Internal shape before delta-encoding
type Tok = {
  line: number
  char: number
  length: number
  typeIndex: number
  mods: number
}

function add(tok: Tok[], line: number, char: number, length: number) {
  if (length <= 0) return
  tok.push({ line, char, length, typeIndex: 0, mods: 0 })
}

function highlightDirective(
  tok: Tok[],
  text: string,
  d: DirectiveSpan
) {
  // Highlight ":name[" or ":name" as a single keyword span
  const start = offsetToPosition(text, d.absStart)
  const prefixLength = d.hasBrackets ? d.innerStart - d.absStart : d.absEnd - d.absStart
  add(tok, start.line, start.character, prefixLength)

  if (d.hasBrackets) {
    // Highlight the closing bracket "]" as keyword
    const rbPos = offsetToPosition(text, d.innerEnd)
    add(tok, rbPos.line, rbPos.character, 1)
  }
}

// ── Text-based fence highlighting ───────────────────────────────────
// Scans the raw text for :::Name (opening) and ::: (closing) fences,
// bypassing AST-derived block positions. This is robust regardless of
// how the AST was constructed (full or chunked parse).

function addFenceTokens(tok: Tok[], text: string) {
  const lines = text.split("\n")
  let inDirective = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inDirective && FENCE_OPEN_RE.test(line)) {
      inDirective = true
      add(tok, i, 0, 3)                                     // :::
      const name = line.slice(3).trimEnd()
      if (name.length > 0) add(tok, i, 3, name.length)      // Name
    } else if (inDirective && FENCE_CLOSE_RE.test(line)) {
      inDirective = false
      add(tok, i, 0, 3)                                     // :::
    }
  }
}

export function buildSemanticTokens(
  text: string,
  bundle: AnalysisBundle,
  range?: Range
): SemanticTokens {
  let tokens: Tok[] = []

  // Directives in user chunks
  for (const d of bundle.directives) {
    highlightDirective(tokens, text, d)
  }

  // Assistant block fences — scanned directly from text
  addFenceTokens(tokens, text)

  // Sort and optionally filter by range
  tokens.sort((a, b) => a.line - b.line || a.char - b.char)

  if (range) {
    const rs = range.start.line
    const re = range.end.line
    tokens = tokens.filter(t => t.line >= rs && t.line <= re)
  }

  // Delta encode as per LSP spec
  const data: number[] = []
  let prevLine = 0
  let prevChar = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const dl = i === 0 ? t.line : (t.line - prevLine)
    const dc = i === 0 || t.line !== prevLine ? t.char : (t.char - prevChar)
    data.push(dl, dc, t.length, t.typeIndex, t.mods)
    prevLine = t.line
    prevChar = t.char
  }

  return { data }
}
