import { describe, test, expect } from "bun:test"
import type { AnalysisBundle } from "./analysisTypes"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

function mkBundleWithToolSpan(start: number, end: number): AnalysisBundle {
  return {
    uri: "file:///doc.lec",
    version: 1,
    headerOffset: 0,
    directives: [],
    links: [],
    blocks: [],
    toolCallBlocks: [{ absStart: start, absEnd: end }],
    inlineAttachmentBlocks: [],
  }
}

describe("hover: tool-call block", () => {
  test("shows for application/xml results", async () => {
    const doc = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="bun-test" id="call_1" is-error="false">\n<arguments><arguments><array></array></arguments></arguments>\n<results>\n<result type="application/xml">\n┆<│stdout>ok\n┆<│/stdout>\n</result>\n</results>\n</tool-call>\n:::\n`

    const s = doc.indexOf("<tool-call")
    const e = doc.indexOf("</tool-call>") + "</tool-call>".length
    expect(s).toBeGreaterThanOrEqual(0)
    expect(e).toBeGreaterThan(s)

    const bundle = mkBundleWithToolSpan(s, e)
    const pos = offsetToPosition(doc, s + 10)
    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()
    const md = (hover!.contents as any).value as string
    expect(md).toContain("result (application/xml)")
    expect(md).toContain("stdout")
  })

  test("indented tool-call (code block) yields no hover when not detected", async () => {
    // Same content but with leading spaces; in real parsing this becomes a
    // fenced/indented code block and the worker will not record a tool span.
    const xml = [
      "    <tool-call with=\"bun-test\" id=\"call_2\" is-error=\"false\">",
      "    <arguments><arguments><array></array></arguments></arguments>",
      "    <results>",
      "    <result type=\"application/xml\">",
      "    ┆<│stdout>ok\n",
      "    ┆<│/stdout>",
      "    </result>",
      "    </results>",
      "    </tool-call>",
    ].join("\n")
    const doc = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n${xml}\n:::\n`

    const s = doc.indexOf("<tool-call")
    const e = doc.indexOf("</tool-call>") + "</tool-call>".length
    expect(s).toBeGreaterThanOrEqual(0)
    expect(e).toBeGreaterThan(s)

    // Simulate worker not detecting an HTML block: provide an empty span list.
    const bundle: AnalysisBundle = {
      uri: "file:///doc.lec",
      version: 1,
      headerOffset: 0,
      directives: [],
      links: [],
      blocks: [],
      toolCallBlocks: [],
      inlineAttachmentBlocks: [],
    }

    const pos = offsetToPosition(doc, s + 10)
    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).toBeNull()
  })
})
