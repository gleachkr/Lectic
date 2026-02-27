import type { FoldingRange as LspFoldingRange } from "vscode-languageserver"
import { FoldingRangeKind } from "vscode-languageserver/node"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { nodeRaw } from "../parsing/markdown"
import { isSerializedCall } from "../types/tool"
import {
  defaultInlineAttachmentIcon,
  isSerializedInlineAttachment,
} from "../types/inlineAttachment"
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
        const collapsedText = getCollapsedText(raw)
        out.push({ 
            startLine, 
            endLine, 
            kind: FoldingRangeKind.Region,
            collapsedText
        })
      }
    }
  }

  return out
}

function getAttribute(line: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(line)
  return match?.[1]
}

function getCollapsedText(raw: string): string {
  const useNerdFont = process.env["NERD_FONT"] === "1"
  const line = raw.split("\n")[0].trim()

  if (line.startsWith("<tool-call")) {
    const name = getAttribute(line, "with") ?? "tool"
    const kind = getAttribute(line, "kind") ?? ""
    const icon = getAttribute(line, "icon") ?? ""

    if (useNerdFont) {
      return `${icon} ${name}`
    }

    const label = kind ? `${kind} tool` : "tool"
    return `[${label}: ${name}]`
  }

  if (line.startsWith("<inline-attachment")) {
    const rawKind = getAttribute(line, "kind") ?? "attach"
    const kind = rawKind === "cmd" ? "attach" : rawKind
    const fallbackIcon = defaultInlineAttachmentIcon(kind)
    const icon = getAttribute(line, "icon") ?? fallbackIcon

    if (useNerdFont) {
      return `${icon} ${kind}`
    }

    return `[${kind}]`
  }

  return "..."
}

export async function buildFoldingRanges(docText: string): Promise<LspFoldingRange[]> {
  const ast = remark().use(remarkDirective).parse(docText)
  return buildFoldingRangesFromAst(ast, docText)
}
