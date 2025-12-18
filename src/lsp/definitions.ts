import type { Position, Location } from "vscode-languageserver"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { buildDefinitionIndex } from "./configIndex"
import { getYaml } from "../parsing/parse"
import { dirname } from "path"
import { directiveAtPosition } from "./directives"
import { inRange } from "./utils/range"

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
  if (dctx) {
    // Macros: :name[] / :name[args]
    {
      const locs = defIndex.getMacros(dctx.key)
      if (locs.length > 0) return locs
    }

    // Interlocutor directives still use bracket content
    if ((dctx.key === "ask" || dctx.key === "aside") && dctx.insideBrackets) {
      const name = dctx.innerText.trim()
      if (name) {
        const locs = defIndex.getInterlocutors(name)
        return locs.length > 0 ? locs : null
      }
    }
  }

  // Then: YAML header agent target → interlocutor definition
  if (idx) {
    for (const a of idx.agentTargetRanges) {
      if (inRange(pos, a.range)) {
        const locs = defIndex.getInterlocutors(a.target)
        return locs.length > 0 ? locs : null
      }
    }

    for (const n of idx.interlocutorNameRanges) {
      if (inRange(pos, n.range)) {
        const locs = defIndex.getInterlocutors(n.name)
          .filter(l => l.uri !== uri)
        return locs.length > 0 ? locs : null
      }
    }

    for (const m of idx.macroNameRanges) {
      if (inRange(pos, m.range)) {
        const locs = defIndex.getMacros(m.name)
          .filter(l => l.uri !== uri)
        return locs.length > 0 ? locs : null
      }
    }

    for (const k of idx.kitTargetRanges) {
      if (inRange(pos, k.range)) {
        const locs = defIndex.getKits(k.target)
        return locs.length > 0 ? locs : null
      }
    }

    for (const kn of idx.kitNameRanges) {
      if (inRange(pos, kn.range)) {
        const locs = defIndex.getKits(kn.name)
          .filter(l => l.uri !== uri)
        return locs.length > 0 ? locs : null
      }
    }
  }

  return null
}
