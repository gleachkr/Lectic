import { describe, test, expect } from "bun:test"
import { buildFoldingRanges } from "./folding"

function toPairs(ranges: any[]): Array<[number, number]> {
  return ranges.map(r => [r.startLine, r.endLine] as [number, number])
}

describe("folding ranges (tool-call)", () => {
  test("simple tool-call folds including closing tag line", async () => {
    const text = `---\n---\nBefore\n<tool-call with=\"x\">\n<arguments>\n</arguments>\n<results>\n</results>\n</tool-call>\nAfter\n`
    const ranges = await buildFoldingRanges(text)
    // open at line 3 (0-based: 0,1 header; 2 Before)
    // lines: 0 ---;1 ---;2 Before;3 <tool-call>;...;8 </tool-call>;9 After
    expect(toPairs(ranges)).toEqual([[3, 8]])
  })

  test("indented opening should not fold", async () => {
    const text = `---\n---\n  <tool-call with=\"x\">\n</tool-call>\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })

  test("closing can be indented; still folds", async () => {
    const text = `---\n---\n<tool-call with=\"x\">\n</results>\n  </tool-call>\n`
    const ranges = await buildFoldingRanges(text)
    // open at 2, close at 4
    expect(toPairs(ranges)).toEqual([[2, 4]])
  })

  test("ignore fenced code containing tool-call text", async () => {
    const text = `---\n---\nBefore\n\n\n\n\n\n\n\n\n\n\n` +
`\n\n\n\n\n\n\n\n` // padding
    const code = [
      "```", 
      "<tool-call with=\"x\">",
      "<arguments>",
      "</arguments>",
      "</tool-call>",
      "```"
    ].join("\n")
    const full = text + code + "\nAfter\n"
    const ranges = await buildFoldingRanges(full)
    expect(ranges.length).toBe(0)
  })

  test("one-line tool-call should not fold", async () => {
    const text = `---\n---\n<tool-call with=\"x\"></tool-call>\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })
})
