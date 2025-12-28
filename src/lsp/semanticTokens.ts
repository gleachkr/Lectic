import type {
  SemanticTokens,
  SemanticTokensLegend,
  Range,
} from "vscode-languageserver"
import type { AnalysisBundle, BlockSpan } from "./analysisTypes"
import { offsetToPosition } from "./positions"

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

function isColon(ch: number) { return ch === 58 /* : */ }
function isSpace(ch: number) { return ch === 32 || ch === 9 }

function headerLineRange(text: string, b: BlockSpan): [number, number] | null {
  const s = b.absStart
  let e = text.indexOf("\n", s)
  if (e < 0 || e > b.absEnd) e = b.absEnd
  return [s, e]
}

function footerLineRange(text: string, b: BlockSpan): [number, number] | null {
  // Find last non-EOL char within the block
  let i = Math.min(b.absEnd - 1, text.length - 1)
  while (i >= b.absStart && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13)) i--
  if (i < b.absStart) return null
  const e = i + 1
  const s = text.lastIndexOf("\n", i)
  const start = s < 0 ? b.absStart : Math.max(b.absStart, s + 1)
  return [start, e]
}

function highlightFenceAndName(tok: Tok[], text: string, lineStart: number, lineEnd: number) {
  // Skip leading spaces
  let i = lineStart
  while (i < lineEnd && isSpace(text.charCodeAt(i))) i++
  // Count leading ':'
  let j = i
  while (j < lineEnd && isColon(text.charCodeAt(j))) j++
  const runLen = j - i
  if (runLen >= 3) {
    const p = offsetToPosition(text, i)
    add(tok, p.line, p.character, runLen) // fence as keyword
    // Name that follows until end or whitespace-only remainder
    let k = j
    while (k < lineEnd && isSpace(text.charCodeAt(k))) k++
    if (k < lineEnd) {
      const nameStart = offsetToPosition(text, k)
      add(tok, nameStart.line, nameStart.character, lineEnd - k) // name as keyword
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

  // Assistant block headers and footers
  for (const b of bundle.blocks) {
    if (b.kind !== 'assistant') continue
    const hdr = headerLineRange(text, b)
    if (hdr) highlightFenceAndName(tokens, text, hdr[0], hdr[1])
    const ftr = footerLineRange(text, b)
    if (ftr) highlightFenceAndName(tokens, text, ftr[0], ftr[1])
  }

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
