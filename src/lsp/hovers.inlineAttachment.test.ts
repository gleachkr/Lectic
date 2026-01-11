import { describe, test, expect } from "bun:test"
import type { AnalysisBundle } from "./analysisTypes"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

function mkBundleForSpan(start: number, end: number): AnalysisBundle {
  return {
    uri: "file:///doc.lec",
    version: 1,
    headerOffset: 0,
    directives: [],
    links: [],
    blocks: [],
    toolCallBlocks: [],
    inlineAttachmentBlocks: [{ absStart: start, absEnd: end }],
  }
}

describe("hover: inline attachment", () => {
  test("shows command and pretty JSON content", async () => {
    const doc = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="attach">\n<command>echo '{"a":1}'</command>\n<content type="application/json">\n┆{"a":1}\n</content>\n</inline-attachment>\n:::\n`

    const s = doc.indexOf("<inline-attachment")
    const e = doc.indexOf("</inline-attachment>") + "</inline-attachment>".length
    expect(s).toBeGreaterThanOrEqual(0)
    expect(e).toBeGreaterThan(s)

    const bundle = mkBundleForSpan(s, e)
    const pos = offsetToPosition(doc, s + 10)
    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()
    const md = (hover!.contents as any).value as string
    expect(md).toContain("## command")
    expect(md).toContain("## content (application/json)")
    // Pretty JSON should have quotes and spacing
    expect(md).toContain('"a": 1')
  })

  test("non-text content reports not previewable", async () => {
    const doc = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="attach">\n<command>echo hi</command>\n<content type="image/png">\n┆iVBOR\n</content>\n</inline-attachment>\n:::\n`

    const s = doc.indexOf("<inline-attachment")
    const e = doc.indexOf("</inline-attachment>") + "</inline-attachment>".length
    const bundle = mkBundleForSpan(s, e)
    const pos = offsetToPosition(doc, s + 5)
    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()
    const md = (hover!.contents as any).value as string
    expect(md).toContain("## content (image/png)")
    expect(md).toContain("(not previewable)")
  })
})
