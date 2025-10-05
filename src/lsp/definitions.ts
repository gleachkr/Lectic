import type { Position, Location } from "vscode-languageserver"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { buildDefinitionIndex } from "./configIndex"
import { getYaml } from "../parsing/parse"
import { dirname } from "path"
import { directiveAtPosition } from "./directives"

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

  // Try body directive first using mdast
  const dctx = directiveAtPosition(docText, pos)
  if (dctx && dctx.insideBrackets) {
    const name = dctx.innerText.trim()
    if (name) {
      if (dctx.key === "macro") {
        const loc = defIndex.getMacro(name)
        return loc ? [loc] : null
      }
      if (dctx.key === "ask" || dctx.key === "aside") {
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
