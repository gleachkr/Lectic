import type { Position } from "vscode-languageserver"
import { parseReferences, nodeRaw } from "../parsing/markdown"
import { positionToOffset } from "./positions"

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

export function linkTargetAtPosition(
  docText: string,
  pos: Position
): { url: string, startOff: number, endOff: number } | null {
  const refs = parseReferences(docText)
  const absPos = positionToOffset(docText, pos)

  for (const node of refs) {
    const s = node.position?.start
    const e = node.position?.end
    if (!s || !e || s.offset == null || e.offset == null) continue

    const dest = node.url

    const raw = nodeRaw(node, docText)
    const rng = findUrlRangeInNodeRaw(raw, s.offset, dest)
    if (!rng) continue
    const [startOff, endOff] = rng

    if (absPos < startOff || absPos > endOff) continue

    return { url: dest, startOff, endOff }
  }
  return null
}
