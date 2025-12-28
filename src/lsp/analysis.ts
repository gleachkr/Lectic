import { getBody } from "../parsing/parse"
import { directivesFromAst, referencesFromAst, nodeRaw, parseBlocks } from "../parsing/markdown"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import { isSerializedCall } from "../types/tool"
import { isSerializedInlineAttachment } from "../types/inlineAttachment"
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

  for (const node of parseBlocks(body)) {
    if (node.type === 'containerDirective' && typeof node.name === 'string') {
      const s = node.position?.start?.offset
      const e = node.position?.end?.offset
      if (typeof s === 'number' && typeof e === 'number') {
        const absS = headerOffset + s
        const absE = headerOffset + e
        assistants.push({ name: String(node.name), s: absS, e: absE })
        if (Array.isArray(node.children)) {
          for (const b of node.children) {
            if (b?.type !== 'html') continue
            const pos = b.position
            if (!pos?.start?.offset || !pos?.end?.offset) continue
            const raw = nodeRaw(b, body)
            const htmlAbsStart = headerOffset + pos.start.offset
            const htmlAbsEnd = headerOffset + pos.end.offset
            if (isSerializedCall(raw)) {
              toolCallBlocks.push({ absStart: htmlAbsStart, absEnd: htmlAbsEnd })
            } else if (isSerializedInlineAttachment(raw)) {
              inlineAttachmentBlocks.push({ absStart: htmlAbsStart, absEnd: htmlAbsEnd })
            }
          }
        }
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

  return { uri, version, headerOffset, directives, links, blocks, toolCallBlocks, inlineAttachmentBlocks }
}

export function buildBundle(docText: string, uri = "file:///doc.lec", version = 1): AnalysisBundle {
  const ast = remark().use(remarkDirective).parse(docText)
  return buildBundleFromAst(ast, docText, uri, version)
}
