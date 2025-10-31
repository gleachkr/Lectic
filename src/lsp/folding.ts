import type { FoldingRange as LspFoldingRange } from "vscode-languageserver"
import { FoldingRange as LspFR, FoldingRangeKind } from "vscode-languageserver/node"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { nodeRaw } from "../parsing/markdown"
import { isSerializedCall } from "../types/tool"
import { isSerializedInlineAttachment } from "../types/inlineAttachment"
import type { Root } from "mdast"

export function buildFoldingRangesFromAst(ast: Root, docText: string): LspFoldingRange[] {
  const out: LspFoldingRange[] = []

  
  for (const node of (ast.children ?? [])) {
    if (node.type !== 'containerDirective') continue
    if (!Array.isArray(node.children)) continue

    for (const b of node.children) {
      if (b.type !== "html") continue
      const pos = b.position
      if (!pos?.start || !pos?.end) continue
      const raw = nodeRaw(b, docText)
      if (!isSerializedCall(raw) && !isSerializedInlineAttachment(raw)) continue

      const startLine =  Math.max(0, (pos.start.line ?? 1) - 1)
      const endLine =  Math.max(0, (pos.end.line ?? 1) - 1)
      if (endLine > startLine) {
        out.push(LspFR.create(startLine, endLine, FoldingRangeKind.Region))
      }
    }
  }

  return out
}

export async function buildFoldingRanges(docText: string): Promise<LspFoldingRange[]> {
  const ast = remark().use(remarkDirective).parse(docText)
  return buildFoldingRangesFromAst(ast, docText)
}
