import type { Position as LspPosition, Range as LspRange } from "vscode-languageserver"
import { Position as LspPos, Range as LspRan } from "vscode-languageserver/node"
import { getBody } from "../parsing/parse"
import { parseDirectives, nodeContentRaw } from "../parsing/markdown"

// Helpers shared across LSP modules
export function findSingleColonStart(lineText: string, ch: number): number | null {
  let idx = ch - 1
  while (idx >= 0 && lineText[idx] !== ":") idx--
  if (idx < 0 || lineText[idx] !== ":") return null
  let left = idx
  while (left - 1 >= 0 && lineText[left - 1] === ":") left--
  let right = idx
  while (right + 1 < lineText.length && lineText[right + 1] === ":") right++
  const runLen = right - left + 1
  if (runLen !== 1) return null
  return idx
}

export function computeReplaceRange(
  line: number,
  colonCol: number,
  curCol: number
): LspRange {
  return LspRan.create(LspPos.create(line, colonCol), LspPos.create(line, curCol))
}


export type DirectiveContext = {
  key: string
  insideBrackets: boolean
  innerText: string
  innerStart: LspPosition
  innerEnd: LspPosition
  nodeStart: LspPosition
  nodeEnd: LspPosition
}

export function directiveAtPosition(
  docText: string,
  pos: LspPosition
): DirectiveContext | null {
  // Parse directives from the body only; compute header end line to
  // convert node-local positions to absolute LSP positions.
  const body = getBody(docText)
  const bodyDirectives = parseDirectives(body)

  // Compute header end line by subtracting body length from full text
  const prefixLen = docText.length - body.length
  const headerPrefix = docText.slice(0, prefixLen)
  const headerEndLine = headerPrefix.split(/\r?\n/).length - 1

  const abs = (line: number, col: number): LspPosition =>
    LspPos.create(headerEndLine + (line - 1), col - 1)

  // Consider the directive whose range contains the cursor position.
  for (const d of bodyDirectives) {
    const s = d.position?.start
    const e = d.position?.end
    if (!s || !e) continue
    const nodeStart = abs(s.line, s.column)
    const nodeEnd = abs(e.line, e.column)

    const within =
      (pos.line > nodeStart.line || (pos.line === nodeStart.line && pos.character >= nodeStart.character)) &&
      (pos.line < nodeEnd.line || (pos.line === nodeEnd.line && pos.character <= nodeEnd.character))
    if (!within) continue

    const key = d.name ? String(d.name).toLowerCase() : ""

    // Compute inner bracket content range using children positions.
    const firstChild = d.children?.[0]?.position?.start
    const lastChild = d.children?.[d.children.length - 1]?.position?.end
    const hasChildren = !!(firstChild && lastChild)
    const innerStart = hasChildren ? abs(firstChild.line, firstChild.column) : nodeStart
    const innerEnd = hasChildren ? abs(lastChild.line, lastChild.column) : nodeStart

    const insideBrackets = hasChildren && (
      (pos.line > innerStart.line || (pos.line === innerStart.line && pos.character >= innerStart.character)) &&
      (pos.line < innerEnd.line || (pos.line === innerEnd.line && pos.character <= innerEnd.character))
    )

    const innerText = hasChildren ? nodeContentRaw(d, body) : ""

    return {
      key,
      insideBrackets,
      innerText,
      innerStart,
      innerEnd,
      nodeStart,
      nodeEnd,
    }
  }

  return null
}
