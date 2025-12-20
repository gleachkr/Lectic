import { describe, test, expect, afterAll } from "bun:test"
import { buildFoldingRanges } from "./folding"

function toPairs(ranges: any[]): Array<[number, number]> {
  return ranges.map(r => [r.startLine, r.endLine] as [number, number])
}

describe("folding ranges (tool-call)", () => {
  test("simple tool-call folds including closing tag line", async () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="x">\n<arguments>\n</arguments>\n<results>\n</results>\n</tool-call>\n:::\nAfter\n`
    const ranges = await buildFoldingRanges(text)
    // open at line 5
    // lines: 0 ---;1 interlocutor:;2   name;3 ---;4 :::Assistant;5 <tool-call>;...;10 </tool-call>;11 :::;12 After
    expect(toPairs(ranges)).toEqual([[5, 10]])
  })

  test("indented opening still folds", async () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n  <tool-call with="x">\n</tool-call>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[5, 6]])
  })

  test("closing can be indented; still folds", async () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="x">\n</results>\n  </tool-call>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    // open at 5, close at 7
    expect(toPairs(ranges)).toEqual([[5, 7]])
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
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="x"></tool-call>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })
})

describe("folding ranges (inline-attachment)", () => {
  test("simple inline-attachment folds including closing tag line", async () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="cmd">\n<command>x</command>\n<content type="text/plain">\n┆hi\n</content>\n</inline-attachment>\n:::\nAfter\n`
    const ranges = await buildFoldingRanges(text)
    // open at line 5, close at 10
    expect(toPairs(ranges)).toEqual([[5, 10]])
  })

  test("one-line inline-attachment should not fold", async () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="cmd"></inline-attachment>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })
})

describe("folding ranges (collapsedText)", () => {
  const originalNerdFont = process.env["NERD_FONT"]

  afterAll(() => {
    process.env["NERD_FONT"] = originalNerdFont
  })

  test("tool-call shows icon and name when NERD_FONT=1", async () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="my_db" kind="sqlite">\n<results>\n</results>\n</tool-call>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("  my_db")
  })

  test("tool-call shows text and name when NERD_FONT is not 1", async () => {
    process.env["NERD_FONT"] = "0"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<tool-call with="my_db" kind="sqlite">\n<results>\n</results>\n</tool-call>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("[sqlite tool: my_db]")
  })

  test("inline-attachment shows cmd icon when NERD_FONT=1", async () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="cmd">\n<command>ls</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("  cmd")
  })

  test("inline-attachment shows hook icon when NERD_FONT=1", async () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n<inline-attachment kind="hook">\n<command>hook.sh</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = await buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("󱐋 hook")
  })
})
