import type { Position, Location } from "vscode-languageserver"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { buildDefinitionIndex } from "./configIndex"
import { getYaml } from "../parsing/parse"
import { dirname } from "path"

function getLine(text: string, line: number): string {
  const lines = text.split(/\r?\n/)
  return lines[line] ?? ""
}

function findSingleColonStart(lineText: string, ch: number): number | null {
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

function parseDirectiveContext(
  lineText: string,
  colonStart: number,
  curCol: number
): { key: string, inner: string | null } {
  let i = colonStart + 1
  let key = ""
  while (i < lineText.length) {
    const ch = lineText[i]
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { key += ch; i++ }
    else break
  }
  const open = lineText.indexOf('[', colonStart + 1)
  const close = lineText.indexOf(']', colonStart + 1)
  const inside = open !== -1 && open < curCol && (close === -1 || curCol <= close)
  if (!inside) return { key: key.toLowerCase(), inner: null }
  // For go-to-definition, prefer the full bracket content when we can
  const endIdx = (close !== -1 ? close : curCol)
  const inner = lineText.slice(open + 1, endIdx)
  return { key: key.toLowerCase(), inner }
}

function inRange(pos: Position, r: { start: Position, end: Position }): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false
  if (pos.line === r.start.line && pos.character < r.start.character) return false
  if (pos.line === r.end.line && pos.character > r.end.character) return false
  return true
}

export async function resolveDefinition(
  uri: string,
  docText: string,
  pos: Position
): Promise<Location[] | null> {
  const idx = buildHeaderRangeIndex(docText)

  const docUrl = new URL(uri)
  const docDir = docUrl.protocol === 'file:' ? dirname(docUrl.pathname) : undefined

  // Build cross-file definition lookup with precedence
  const localYaml = getYaml(docText) ?? ""
  const defIndex = await buildDefinitionIndex(
    docDir,
    { uri, text: localYaml }
  )

  // Try body directive first
  const lineText = getLine(docText, pos.line)
  const colonStart = findSingleColonStart(lineText, pos.character)
  if (colonStart !== null) {
    const ctx = parseDirectiveContext(lineText, colonStart, pos.character)
    if (ctx.inner) {
      const name = ctx.inner.trim()
      if (!name) return null
      if (ctx.key === "macro") {
        const loc = defIndex.getMacro(name)
        return loc ? [loc] : null
      }
      if (ctx.key === "ask" || ctx.key === "aside") {
        const loc = defIndex.getInterlocutor(name)
        return loc ? [loc] : null
      }
    }
  }

  // Then: YAML header agent target → interlocutor definition
  if (idx) {
    for (const a of idx.agentTargetRanges) {
      if (inRange(pos, a.range)) {
        const loc = defIndex.getInterlocutor(a.target)
        return loc ? [loc] : null
      }
    }
  }

  return null
}
