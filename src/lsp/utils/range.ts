import type { Position, Range } from "vscode-languageserver"

export function inRange(pos: Position, r: Range): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false
  if (pos.line === r.start.line && pos.character < r.start.character) return false
  if (pos.line === r.end.line && pos.character > r.end.character) return false
  return true
}
