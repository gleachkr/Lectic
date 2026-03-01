import { describe, test, expect } from "bun:test"
import type { AnalysisBundle } from "./analysisTypes"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

function mkBundleWithThoughtSpan(
  start: number,
  end: number
): AnalysisBundle {
  return {
    uri: "file:///doc.lec",
    version: 1,
    headerOffset: 0,
    directives: [],
    links: [],
    blocks: [],
    toolCallBlocks: [],
    inlineAttachmentBlocks: [],
    thoughtBlockBlocks: [{ absStart: start, absEnd: end }],
  }
}

describe("hover: thought-block", () => {
  test("shows provider metadata and section previews", async () => {
    const doc = [
      "---\ninterlocutor:\n  name: Assistant\n---\n",
      ":::Assistant\n",
      '<thought-block provider="openai"',
      ' provider-kind="reasoning"',
      ' status="completed">\n',
      "<summary>\n",
      "┆Need to inspect the parser output first.\n",
      "</summary>\n",
      '<opaque name="encrypted_content">',
      "AbCdEf==</opaque>\n",
      "</thought-block>\n",
      ":::\n",
    ].join("")

    const s = doc.indexOf("<thought-block")
    const e =
      doc.indexOf("</thought-block>") +
      "</thought-block>".length
    expect(s).toBeGreaterThanOrEqual(0)
    expect(e).toBeGreaterThan(s)

    const bundle = mkBundleWithThoughtSpan(s, e)
    const pos = offsetToPosition(doc, s + 10)
    const hover = await computeHover(
      doc,
      pos,
      undefined,
      bundle
    )

    expect(hover).not.toBeNull()
    const md = (hover!.contents as any).value as string
    expect(md).toContain("Provider: openai reasoning")
    expect(md).toContain("Status: completed")
    expect(md).toContain(
      "Need to inspect the parser output first."
    )
    // Opaque data is not previewable
    expect(md).toContain("opaque: encrypted_content")
    expect(md).toContain("not previewable")
  })
})
