import type { DocumentSymbol, Range } from "vscode-languageserver"
import { Range as LspRange, SymbolKind as LspSymbolKind } from "vscode-languageserver/node"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { getBody } from "../parsing/parse"
import { offsetToPosition, positionToOffset } from "./positions"
import type { AnalysisBundle } from "./analysisTypes"

function rangeContains(a: Range, b: Range): boolean {
  const aStart = a.start
  const aEnd = a.end
  const bStart = b.start
  const bEnd = b.end
  if (aStart.line > bStart.line) return false
  if (aStart.line === bStart.line && aStart.character > bStart.character) return false
  if (aEnd.line < bEnd.line) return false
  if (aEnd.line === bEnd.line && aEnd.character < bEnd.character) return false
  return true
}

function smallestEnclosing(range: Range, candidates: Range[]): Range | null {
  let best: Range | null = null
  for (const c of candidates) {
    if (rangeContains(c, range)) {
      if (!best) best = c
      else {
        // pick the one with the smallest area (approx by offsets)
        const bSize = (best.end.line - best.start.line) * 1e6 +
                      (best.end.character - best.start.character)
        const cSize = (c.end.line - c.start.line) * 1e6 +
                      (c.end.character - c.start.character)
        if (cSize < bSize) best = c
      }
    }
  }
  return best
}

function toRange(text: string, startOff: number, endOff: number): Range {
  return LspRange.create(offsetToPosition(text, startOff), offsetToPosition(text, endOff))
}

function firstLineLen(text: string, startOff: number): number {
  const nl = text.indexOf("\n", startOff)
  if (nl === -1) return Math.min(80, text.length - startOff)
  return nl - startOff
}

function trimBlankSpan(text: string, fromOff: number, toOff: number): [number, number] | null {
  // Trim leading blanks
  let s = fromOff
  while (s < toOff) {
    const ch = text.charCodeAt(s)
    if (ch === 32 /* space */ || ch === 9 /* tab */ || ch === 13 /* \r */ || ch === 10 /* \n */) s++
    else break
  }
  // Trim trailing blanks
  let e = toOff
  while (e > s) {
    const ch = text.charCodeAt(e - 1)
    if (ch === 32 || ch === 9 || ch === 13 || ch === 10) e--
    else break
  }
  if (e <= s) return null
  return [s, e]
}

export function buildDocumentSymbols(docText: string, bundle: AnalysisBundle): DocumentSymbol[] {
  const out: DocumentSymbol[] = []

  // Header groups from YAML ranges
  const hdr = buildHeaderRangeIndex(docText)
  if (hdr) {
    const headerChildren: DocumentSymbol[] = []

    if (hdr.interlocutorNameRanges.length) {
      const leaves: DocumentSymbol[] = hdr.interlocutorNameRanges.map(({ name, range }) => {
        const encl = smallestEnclosing(range, hdr.fieldRanges.map(fr => fr.range)) || range
        return {
          name,
          kind: LspSymbolKind.Class,
          range: encl,
          selectionRange: range,
        }
      })
      headerChildren.push({
        name: "Interlocutors",
        kind: LspSymbolKind.Namespace,
        range: hdr.headerFullRange,
        selectionRange: hdr.headerFullRange,
        children: leaves,
      })
    }

    if (hdr.macroNameRanges.length) {
      const leaves: DocumentSymbol[] = hdr.macroNameRanges.map(({ name, range }) => {
        const encl = smallestEnclosing(range, hdr.fieldRanges.map(fr => fr.range)) || range
        return {
          name,
          kind: LspSymbolKind.Function,
          range: encl,
          selectionRange: range,
        }
      })
      headerChildren.push({
        name: "Macros",
        kind: LspSymbolKind.Namespace,
        range: hdr.headerFullRange,
        selectionRange: hdr.headerFullRange,
        children: leaves,
      })
    }

    if (headerChildren.length) {
      out.push({
        name: "Header",
        kind: LspSymbolKind.Module,
        range: hdr.headerFullRange,
        selectionRange: hdr.headerFullRange,
        children: headerChildren,
      })
    }
  }

  // Body groups (assistant containers and user chunks)
  const body = getBody(docText)
  const bodyStartOff = docText.length - body.length
  type Seg = { name: string, start: number, end: number }
  const assistants: Seg[] = []

  for (const b of bundle.blocks) {
    if (b.kind === 'assistant') assistants.push({ name: b.name ?? 'Assistant', start: b.absStart, end: b.absEnd })
  }

  assistants.sort((a, b) => a.start - b.start)

  const bodyChildren: DocumentSymbol[] = []

  let cursor = hdr ? positionToOffset(docText, hdr.headerFullRange.end) : 0
  if (cursor < bodyStartOff) cursor = bodyStartOff

  const pushUser = (from: number, to: number) => {
    const span = trimBlankSpan(docText, from, to)
    if (!span) return
    const [s, e] = span
    const line = offsetToPosition(docText, s).line + 1
    const selLen = firstLineLen(docText, s)
    bodyChildren.push({
      name: `User @ line ${line}`,
      kind: LspSymbolKind.String,
      range: toRange(docText, s, e),
      selectionRange: toRange(docText, s, s + selLen),
    })
  }

  for (const a of assistants) {
    // User chunk before this assistant
    pushUser(cursor, a.start)
    // Assistant block
    const selLen = firstLineLen(docText, a.start)
    bodyChildren.push({
      name: `Assistant: ${a.name}`,
      kind: LspSymbolKind.Method,
      range: toRange(docText, a.start, a.end),
      selectionRange: toRange(docText, a.start, a.start + selLen),
    })
    cursor = a.end
  }
  // Trailing user chunk after the last assistant
  pushUser(cursor, docText.length)

  if (bodyChildren.length) {
    const first = bodyChildren[0]?.range.start ?? offsetToPosition(docText, bodyStartOff)
    const last = bodyChildren[bodyChildren.length - 1]?.range.end ?? offsetToPosition(docText, docText.length)
    out.push({
      name: "Body",
      kind: LspSymbolKind.Namespace,
      range: LspRange.create(first, last),
      selectionRange: LspRange.create(first, first),
      children: bodyChildren,
    })
  }

  return out
}
