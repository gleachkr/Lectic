import type { FoldingRange as LspFoldingRange } from "vscode-languageserver"
import { FoldingRange as LspFR, FoldingRangeKind } from "vscode-languageserver/node"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { nodeContentRaw, parseBlocks } from "../parsing/markdown"
import { isSerializedCall } from "../types/tool"

export async function buildFoldingRanges(docText: string): Promise<LspFoldingRange[]> {
  // Build allowable assistant names to ensure calls are inside an
  // interlocutor container directive.

  const ast = remark().use(remarkDirective).parse(docText)
  const out: LspFoldingRange[] = []

  for (const node of ast.children ?? []) {
    if (node.type !== 'containerDirective') continue

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
