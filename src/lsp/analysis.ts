import { getBody } from "../parsing/parse"
import { directivesFromAst, referencesFromAst, nodeRaw } from "../parsing/markdown"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import { isSerializedCall } from "../types/tool"
import { isSerializedInlineAttachment } from "../types/inlineAttachment"
import { isSerializedThoughtBlock } from "../types/thought"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { Root } from "mdast"
import type {
  AnalysisBundle,
  DirectiveSpan,
  LinkSpan,
  BlockSpan,
  ToolCallBlockSpan,
  InlineAttachmentBlockSpan,
  ThoughtBlockSpan,
} from "./analysisTypes"

export function buildBundleFromAst(
  ast: Root,
  docText: string,
  uri: string,
  version: number
): AnalysisBundle {
  const directives: DirectiveSpan[] = []
  const links: LinkSpan[] = []
  const blocks: BlockSpan[] = []
  const toolCallBlocks: ToolCallBlockSpan[] = []
  const inlineAttachmentBlocks: InlineAttachmentBlockSpan[] = []
  const thoughtBlockBlocks: ThoughtBlockSpan[] = []

  const body = getBody(docText)
  const headerOffset = docText.length - body.length

  for (const d of directivesFromAst(ast)) {
    const s = d.position?.start?.offset
    const e = d.position?.end?.offset
    if (typeof s !== 'number' || typeof e !== 'number') continue
    const raw = nodeRaw(d, docText)
    const l = raw.indexOf("[")
    const r = raw.lastIndexOf("]")
    const hasBrackets = l >= 0 && r >= 0 && r > l
    const innerStart = hasBrackets ? s + l + 1 : e
    const innerEnd = hasBrackets ? s + r : e
    directives.push({
      key: typeof d.name === 'string' ? d.name.toLowerCase() : '',
      absStart: s,
      absEnd: e,
      innerStart,
      innerEnd,
      hasBrackets,
    })
  }

  for (const n of referencesFromAst(ast)) {
    const s = n.position?.start?.offset
    const e = n.position?.end?.offset
    if (typeof s !== 'number' || typeof e !== 'number') continue
    const raw = nodeRaw(n, docText)
    const rng = findUrlRangeInNodeRaw(raw, s, String(n.url ?? ''))
    if (!rng) continue
    const [us, ue] = rng
    links.push({ absStart: s, absEnd: e, urlStart: us, urlEnd: ue })
  }

  type Asst = { name: string, s: number, e: number }
  const assistants: Asst[] = []

  for (const node of ast.children ?? []) {
    if (node.type !== "containerDirective") continue
    if (typeof node.name !== "string") continue

    const s = node.position?.start?.offset
    const e = node.position?.end?.offset
    if (typeof s !== "number" || typeof e !== "number") continue
    if (s < headerOffset) continue

    assistants.push({ name: node.name, s, e })

    if (!Array.isArray(node.children)) continue

    for (const child of node.children) {
      if (child.type !== "html") continue

      const childStart = child.position?.start?.offset
      const childEnd = child.position?.end?.offset
      if (typeof childStart !== "number" || typeof childEnd !== "number") {
        continue
      }

      const raw = nodeRaw(child, docText)
      if (isSerializedCall(raw)) {
        toolCallBlocks.push({ absStart: childStart, absEnd: childEnd })
      } else if (isSerializedInlineAttachment(raw)) {
        inlineAttachmentBlocks.push({ absStart: childStart, absEnd: childEnd })
      } else if (isSerializedThoughtBlock(raw)) {
        thoughtBlockBlocks.push({ absStart: childStart, absEnd: childEnd })
      }
    }
  }
  assistants.sort((a, b) => a.s - b.s)

  let cursor = headerOffset
  for (const a of assistants) {
    if (a.s > cursor) {
      blocks.push({ kind: 'user', absStart: cursor, absEnd: a.s })
    }
    blocks.push({ kind: 'assistant', absStart: a.s, absEnd: a.e, name: a.name })
    cursor = a.e
  }
  if (cursor < docText.length) blocks.push({ kind: 'user', absStart: cursor, absEnd: docText.length })

  return {
    uri,
    version,
    headerOffset,
    directives,
    links,
    blocks,
    toolCallBlocks,
    inlineAttachmentBlocks,
    thoughtBlockBlocks,
  }
}

export function buildBundle(docText: string, uri = "file:///doc.lec", version = 1): AnalysisBundle {
  const ast = remark().use(remarkDirective).parse(docText)
  return buildBundleFromAst(ast, docText, uri, version)
}
