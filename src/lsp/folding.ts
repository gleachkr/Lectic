import type { FoldingRange as LspFoldingRange } from "vscode-languageserver"
import { FoldingRange as LspFR, FoldingRangeKind } from "vscode-languageserver/node"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { nodeContentRaw, parseBlocks } from "../parsing/markdown"
import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { buildInterlocutorIndex } from "./interlocutorIndex"
import { isSerializedCall } from "../types/tool"

export async function buildFoldingRanges(
  docText: string,
  docDir?: string
): Promise<LspFoldingRange[]> {
  // Build allowable assistant names to ensure calls are inside an
  // interlocutor container directive.
  let namesLower = new Set<string>()
  try {
    const spec = await mergedHeaderSpecForDoc(docText, docDir)
    const names = buildInterlocutorIndex(spec as any)
    namesLower = new Set(names.map(n => n.toLowerCase()))
  } catch {
    // If header merge fails, leave set empty; no folds emitted.
    namesLower = new Set<string>()
  }

  const ast: any = remark().use(remarkDirective).parse(docText)
  const out: LspFoldingRange[] = []

  for (const node of ast.children ?? []) {
    if (node.type !== 'containerDirective') continue
    const name: string = String(node.name || '')
    if (!namesLower.has(name.toLowerCase())) continue

    if (!Array.isArray(node.children) || node.children.length === 0) continue

    // Compute base line for inner content (0-based)
    const baseLine = Math.max(0, (node.children[0].position?.start?.line ?? 1) - 1)

    const inner = nodeContentRaw(node, docText)
    const blocks = parseBlocks(inner)

    for (const b of blocks) {
      const pos = b.position
      if (!pos?.start || !pos?.end) continue
      const raw = inner.slice(pos.start.offset ?? 0, pos.end.offset ?? 0)
      if (!isSerializedCall(raw)) continue

      const startLine = baseLine + Math.max(0, (pos.start.line ?? 1) - 1)
      const endLine = baseLine + Math.max(0, (pos.end.line ?? 1) - 1)
      if (endLine > startLine) {
        out.push(LspFR.create(startLine, endLine, FoldingRangeKind.Region))
      }
    }
  }

  return out
}
