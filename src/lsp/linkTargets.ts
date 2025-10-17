import type { Position } from "vscode-languageserver"
import { positionToOffset } from "./positions"
import type { AnalysisBundle } from "./analysisTypes"

export function findUrlRangeInNodeRaw(
  raw: string,
  absStart: number,
  url: string
): [number, number] | null {
  const l = raw.indexOf("(")
  const r = raw.lastIndexOf(")")
  if (l < 0 || r < 0 || r <= l) return null
  const inner = raw.slice(l + 1, r)

  const idx = inner.indexOf(url)
  if (idx >= 0) {
    const start = absStart + l + 1 + idx
    return [start, start + url.length]
  }

  if (inner.startsWith("<")) {
    const end = inner.indexOf(">")
    if (end > 1) {
      const start = absStart + l + 2
      return [start, absStart + l + 1 + end]
    }
  }
  const ws = inner.search(/[\s]/)
  const endIdx = ws >= 0 ? ws : inner.length
  const start = absStart + l + 1
  return [start, start + endIdx]
}

export function linkTargetAtPositionFromBundle(
  docText: string,
  pos: Position,
  bundle: AnalysisBundle
): { url: string, startOff: number, endOff: number } | null {
  const absPos = positionToOffset(docText, pos)
  for (const L of bundle.links) {
    if (absPos < L.urlStart || absPos > L.urlEnd) continue
    const url = docText.slice(L.urlStart, L.urlEnd)
    return { url, startOff: L.urlStart, endOff: L.urlEnd }
  }
  return null
}
