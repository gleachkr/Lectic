import type { Root } from "mdast"
import type { Node } from "unist"
import { visit } from "unist-util-visit"

export type Chunk = {
  text: string
  offset: number
  lineOffset: number
}

// ── Chunk splitting ─────────────────────────────────────────────────
// Splits a document at container directive boundaries (:::Name / :::).
// Each chunk is either a header/user region or an assistant block.

export const FENCE_OPEN_RE = /^:::\w/
export const FENCE_CLOSE_RE = /^:::\s*$/

export function splitChunks(text: string): Chunk[] {
  const lines = text.split("\n")
  const chunks: Chunk[] = []
  let chunkStartLine = 0
  let chunkStartOffset = 0
  let currentOffset = 0
  let inDirective = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineLen = line.length + 1 // +1 for \n

    if (!inDirective && FENCE_OPEN_RE.test(line)) {
      // Flush any preceding text as a chunk
      if (i > chunkStartLine) {
        const chunkText = lines.slice(chunkStartLine, i).join("\n")
        chunks.push({
          text: chunkText,
          offset: chunkStartOffset,
          lineOffset: chunkStartLine,
        })
      }
      chunkStartLine = i
      chunkStartOffset = currentOffset
      inDirective = true
    } else if (inDirective && FENCE_CLOSE_RE.test(line)) {
      // End of directive — flush the directive chunk (inclusive of closing :::)
      const chunkText = lines.slice(chunkStartLine, i + 1).join("\n")
      chunks.push({
        text: chunkText,
        offset: chunkStartOffset,
        lineOffset: chunkStartLine,
      })
      inDirective = false
      chunkStartLine = i + 1
      chunkStartOffset = currentOffset + lineLen
    }

    currentOffset += lineLen
  }

  // Flush remaining text
  if (chunkStartLine < lines.length) {
    const chunkText = lines.slice(chunkStartLine).join("\n")
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        offset: chunkStartOffset,
        lineOffset: chunkStartLine,
      })
    }
  }

  return chunks
}

// ── Hashing ─────────────────────────────────────────────────────────

export function hashChunk(text: string): string {
  return String(Bun.hash(text))
}

// ── Position shifting ───────────────────────────────────────────────
// Clone a chunk AST and shift all positions to document-absolute values.

type Position = { line: number; column: number; offset?: number }

function shiftPosition(pos: Position, offset: number, lineOffset: number): void {
  if (typeof pos.offset === "number") {
    pos.offset += offset
  }
  pos.line += lineOffset
}

export function shiftPositions(root: Root, offset: number, lineOffset: number): Root {
  if (offset === 0 && lineOffset === 0) return root
  const cloned = structuredClone(root)
  visit(cloned, (node: Node) => {
    if (node.position) {
      shiftPosition(node.position.start, offset, lineOffset)
      shiftPosition(node.position.end, offset, lineOffset)
    }
  })
  return cloned
}

// ── Merging ─────────────────────────────────────────────────────────
// Concatenate children from multiple shifted chunk ASTs into one Root.

export function mergeChunkAsts(shifted: Root[]): Root {
  if (shifted.length === 1) return shifted[0]
  const root: Root = { type: "root", children: [] }
  for (const ast of shifted) {
    root.children.push(...ast.children)
  }
  return root
}
