import { remark } from "remark"
import remarkDirective from "remark-directive"
import { getBody } from "../parsing/parse"
import { directivesFromAst, referencesFromAst, nodeRaw, parseBlocks } from "../parsing/markdown"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import type { AnalysisBundle, DirectiveSpan, LinkSpan, BlockSpan, ToolCallBlockSpan } from "./analysisTypes"

export function buildTestBundle(docText: string, uri = "file:///doc.lec", version = 1): AnalysisBundle {
  const ast = remark().use(remarkDirective).parse(docText) as any
  const directives: DirectiveSpan[] = []
  const links: LinkSpan[] = []
  const blocks: BlockSpan[] = []
  const toolCallBlocks: ToolCallBlockSpan[] = []

  const body = getBody(docText)
  const headerOffset = docText.length - body.length

  for (const d of directivesFromAst(ast) as any[]) {
    const s = d.position?.start?.offset
    const e = d.position?.end?.offset
    if (typeof s !== 'number' || typeof e !== 'number') continue
    const raw = nodeRaw(d, docText)
    const l = raw.indexOf("[")
    const r = raw.lastIndexOf("]")
    if (l < 0 || r < 0 || r <= l) continue
    const innerStart = s + l + 1
    const innerEnd = s + r
    directives.push({
      key: typeof d.name === 'string' ? d.name.toLowerCase() : '',
      absStart: s,
      absEnd: e,
      innerStart,
      innerEnd,
    })
  }

  for (const n of referencesFromAst(ast) as any[]) {
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
  for (const node of (parseBlocks(body) as any[])) {
    if (node.type === 'containerDirective' && typeof node.name === 'string') {
      const s = node.position?.start?.offset
      const e = node.position?.end?.offset
      if (typeof s === 'number' && typeof e === 'number') {
        assistants.push({ name: String(node.name), s: headerOffset + s, e: headerOffset + e })
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

  return { uri, version, headerOffset, directives, links, blocks, toolCallBlocks, inlineAttachmentBlocks: [] }
}
