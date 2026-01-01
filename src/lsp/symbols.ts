import type { DocumentSymbol, Range } from "vscode-languageserver"
import {
  Range as LspRange,
  SymbolKind as LspSymbolKind,
} from "vscode-languageserver/node"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { getBody } from "../parsing/parse"
import { offsetToPosition } from "./positions"
import type { AnalysisBundle } from "./analysisTypes"
import { unescapeTags } from "../parsing/xml"

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

function truncate(s: string, max = 60): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function previewFromSpan(
  docText: string,
  fromOff: number,
  toOff: number,
  opts?: {
    skipLeadingDirectiveLine?: boolean
    skipXmlBlocks?: boolean
    maxScanChars?: number
    maxPreviewChars?: number
  }
): string {
  const maxScan = opts?.maxScanChars ?? 4000
  const maxPrev = opts?.maxPreviewChars ?? 60
  const span = trimBlankSpan(docText, fromOff, toOff)
  if (!span) return ""
  const [s, e] = span

  const snippet = docText.slice(s, Math.min(e, s + maxScan))
  const lines = snippet.split(/\r?\n/)

  let i = 0
  if (opts?.skipLeadingDirectiveLine) i++

  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    if (opts?.skipXmlBlocks) {
      if (line.startsWith("<tool-call")) continue
      if (line.startsWith("<inline-attachment")) continue
    }

    return truncate(collapseWhitespace(line), maxPrev)
  }

  return ""
}

function toolCallLabel(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw.trim()
  const nameMatch = /with="([^"]*)"/.exec(firstLine)
  const kindMatch = /kind="([^"]*)"/.exec(firstLine)
  const name = nameMatch?.[1] ?? "tool"
  const kind = kindMatch?.[1]
  return kind ? `${kind}: ${name}` : `tool: ${name}`
}

function inlineAttachmentLabel(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw.trim()
  const kindMatch = /kind="([^"]*)"/.exec(firstLine)
  const kind = kindMatch?.[1] ?? "cmd"

  // Try to pluck the <command> element (it's near the top).
  const m = /<command>([\s\S]*?)<\/command>/.exec(raw)
  const cmd = m ? unescapeTags(m[1]) : ""
  const cmdLine = truncate(collapseWhitespace(cmd), 50)

  if (cmdLine) return `${kind}: ${cmdLine}`
  return `${kind} attachment`
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
        kind: LspSymbolKind.Namespace,
        range: hdr.headerFullRange,
        selectionRange: hdr.headerFullRange,
        children: headerChildren,
      })
    }
  }

  // Body groups (messages + nested tool calls / attachments)
  const body = getBody(docText)
  const bodyStartOff = docText.length - body.length

  type ChildSpan = {
    kind: 'tool-call' | 'inline-attachment'
    absStart: number
    absEnd: number
  }

  const childSpans: ChildSpan[] = [
    ...bundle.toolCallBlocks.map(b => ({
      kind: 'tool-call' as const,
      absStart: b.absStart,
      absEnd: b.absEnd,
    })),
    ...bundle.inlineAttachmentBlocks.map(b => ({
      kind: 'inline-attachment' as const,
      absStart: b.absStart,
      absEnd: b.absEnd,
    })),
  ].sort((a, b) => a.absStart - b.absStart)

  let childCursor = 0

  const bodyChildren: DocumentSymbol[] = []

  for (const block of bundle.blocks) {
    const bs = Math.max(block.absStart, bodyStartOff)
    const be = Math.max(bs, block.absEnd)

    if (block.kind === 'user') {
      const span = trimBlankSpan(docText, bs, be)
      if (!span) continue
      const [s, e] = span
      const selLen = firstLineLen(docText, s)
      const preview = previewFromSpan(docText, s, e, { maxPreviewChars: 60 })
      const name = preview ? `User: ${preview}` : "User"

      bodyChildren.push({
        name,
        kind: LspSymbolKind.Event,
        range: toRange(docText, s, e),
        selectionRange: toRange(docText, s, s + selLen),
      })
      continue
    }

    // Assistant message block
    const selLen = firstLineLen(docText, bs)
    const preview = previewFromSpan(docText, bs, be, {
      skipLeadingDirectiveLine: true,
      skipXmlBlocks: true,
      maxPreviewChars: 60,
    })
    const speaker = block.name ?? "Assistant"
    const name = preview ? `${speaker}: ${preview}` : speaker

    // Find child blocks contained by this assistant block.
    while (childCursor < childSpans.length &&
           childSpans[childCursor].absEnd <= bs) {
      childCursor++
    }

    const children: DocumentSymbol[] = []
    let i = childCursor
    for (; i < childSpans.length; i++) {
      const c = childSpans[i]
      if (c.absStart >= be) break
      if (c.absStart < bs || c.absEnd > be) continue

      const cSelLen = firstLineLen(docText, c.absStart)
      let cName = ""
      let cKind = LspSymbolKind.Object
      if (c.kind === 'tool-call') {
        const raw = docText.slice(c.absStart, Math.min(c.absEnd, c.absStart + 400))
        cName = toolCallLabel(raw)
        cKind = LspSymbolKind.Function
      } else {
        const raw = docText.slice(c.absStart, Math.min(c.absEnd, c.absStart + 4000))
        cName = inlineAttachmentLabel(raw)
        cKind = LspSymbolKind.File
      }

      children.push({
        name: cName,
        kind: cKind,
        range: toRange(docText, c.absStart, c.absEnd),
        selectionRange: toRange(docText, c.absStart, c.absStart + cSelLen),
      })
    }
    childCursor = i

    bodyChildren.push({
      name,
      kind: LspSymbolKind.Event,
      range: toRange(docText, bs, be),
      selectionRange: toRange(docText, bs, bs + selLen),
      children: children.length ? children : undefined,
    })
  }

  if (bodyChildren.length) {
    const first = bodyChildren[0]?.range.start
      ?? offsetToPosition(docText, bodyStartOff)
    const last = bodyChildren[bodyChildren.length - 1]?.range.end
      ?? offsetToPosition(docText, docText.length)

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
