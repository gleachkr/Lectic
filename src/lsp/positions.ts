import type { Position } from "vscode-languageserver"
import { Position as LspPosition } from "vscode-languageserver/node"

export function offsetToPosition(text: string, offset: number): Position {
  let line = 0
  let col = 0
  const len = Math.min(offset, text.length)
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10 /* \n */) { line++; col = 0 }
    else if (ch === 13 /* \r */) {
      if (i + 1 < len && text.charCodeAt(i + 1) === 10) i++
      line++; col = 0
    } else col++
  }
  return LspPosition.create(line, col)
}

export function positionToOffset(text: string, pos: Position): number {
  let line = 0
  let off = 0
  const len = text.length
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i)
    if (line === pos.line && (pos.character === 0 || off === pos.character)) {
      return i
    }
    if (ch === 10 /* \n */) {
      line++
      off = 0
      if (line > pos.line) return i + 1
    } else if (ch === 13 /* \r */) {
      if (i + 1 < len && text.charCodeAt(i + 1) === 10) i++
      line++
      off = 0
      if (line > pos.line) return i + 1
    } else {
      off++
      if (line === pos.line && off === pos.character) return i + 1
    }
  }
  return len
}
