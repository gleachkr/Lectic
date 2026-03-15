import { describe, test, expect, afterAll } from "bun:test"
import { buildFoldingRanges } from "./folding"
import { defaultInlineAttachmentIcon } from "../types/inlineAttachment"

function toPairs(ranges: any[]): Array<[number, number]> {
  return ranges.map(r => [r.startLine, r.endLine] as [number, number])
}

describe("folding ranges (tool-call)", () => {
  test("simple tool-call folds including closing tag line", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="x">\n<arguments>\n</arguments>\n<results>\n</results>\n</tool-call>\n:::\nAfter\n`
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[6, 11]])
  })

  test("closing can be indented; still folds", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="x">\n</results>\n  </tool-call>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[6, 8]])
  })

  test("one-line tool-call should not fold", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="x"></tool-call>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })
})

describe("folding ranges (inline-attachment)", () => {
  test("simple inline-attachment folds including closing tag line", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="attach">\n<command>x</command>\n<content type="text/plain">\n┆hi\n</content>\n</inline-attachment>\n:::\nAfter\n`
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[6, 11]])
  })

  test("one-line inline-attachment should not fold", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="attach"></inline-attachment>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges.length).toBe(0)
  })
})

describe("folding ranges (thought-block)", () => {
  test("simple thought-block folds including closing tag line", () => {
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<thought-block provider="openai" provider-kind="reasoning">\n<summary>\n┆inspect parser\n</summary>\n</thought-block>\n:::\nAfter\n`
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[6, 10]])
  })
})

// ── Fenced code block exclusion ─────────────────────────────────────

describe("fenced code blocks", () => {
  test("backtick fence hides tool-call", () => {
    const text = [
      "Some text",
      "",
      "```",
      "<tool-call with=\"x\">",
      "<arguments>",
      "</arguments>",
      "</tool-call>",
      "```",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("backtick fence with info string hides tool-call", () => {
    const text = [
      "Some text",
      "",
      "```typescript",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "```",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("tilde fence hides tool-call", () => {
    const text = [
      "Some text",
      "",
      "~~~",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "~~~",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("long fence requires matching length to close", () => {
    // Open with 5 backticks; 3 backticks inside should not close
    const text = [
      "Some text",
      "",
      "`````",
      "```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "```",
      "`````",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("indented fence (1-3 spaces) still counts", () => {
    const text = [
      "Some text",
      "",
      "   ```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "   ```",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("4-space indent is NOT a fence", () => {
    // 4 spaces is too many — not a valid fence opening
    const text = [
      "Some text",
      "",
      "    ```",
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[4, 5]])
  })

  test("mismatched fence char does not close (open backtick, line with tildes)", () => {
    const text = [
      "Some text",
      "",
      "```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "~~~",          // does NOT close the backtick fence
      "```",          // this closes it
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("shorter closing fence does not close", () => {
    // Open with 4, try close with 3 — doesn't close
    const text = [
      "Some text",
      "",
      "````",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "```",          // too short
      "````",         // this closes it
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("longer closing fence DOES close", () => {
    const text = [
      "Some text",
      "",
      "```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "`````",        // longer is fine
      "",
      "<inline-attachment kind=\"hook\">",
      "</inline-attachment>",
      "",
    ].join("\n")
    // Only the inline-attachment after the fence should fold
    expect(toPairs(buildFoldingRanges(text))).toEqual([[7, 8]])
  })

  test("foldable tag after code block closes does fold", () => {
    const text = [
      "Some text",
      "",
      "```",
      "code here",
      "```",
      "",
      "<tool-call with=\"x\">",
      "<arguments>",
      "</arguments>",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[6, 9]])
  })

  test("closing fence with trailing spaces still closes", () => {
    const text = [
      "Some text",
      "",
      "```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "```   ",       // trailing spaces are fine
      "",
      "<tool-call with=\"y\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[7, 8]])
  })

  test("closing fence with trailing non-space text does not close", () => {
    // For backtick fences, closing line must contain only the fence + optional spaces
    const text = [
      "Some text",
      "",
      "```",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "``` foo",       // not a valid closing fence
      "```",           // this closes
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("backtick info string with backticks invalidates fence opening", () => {
    // CommonMark: backtick fences cannot have backticks in info string
    const text = [
      "Some text",
      "",
      "``` foo`bar",   // invalid: backtick in info string
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    const ranges = buildFoldingRanges(text)
    expect(toPairs(ranges)).toEqual([[4, 5]])
  })

  test("tilde info string with backticks is valid", () => {
    // Tilde fences CAN have backticks in info string
    const text = [
      "Some text",
      "",
      "~~~ foo`bar",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "~~~",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })
})

// ── HTML comment exclusion ──────────────────────────────────────────

describe("HTML comments", () => {
  test("multi-line HTML comment hides tool-call", () => {
    const text = [
      "Some text",
      "",
      "<!--",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "-->",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("single-line comment before foldable does not interfere", () => {
    const text = [
      "Some text",
      "",
      "<!-- a comment -->",
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[4, 5]])
  })

  test("comment that opens and closes on same line", () => {
    const text = [
      "<!-- short -->",
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[2, 3]])
  })

  test("foldable after comment closes does fold", () => {
    const text = [
      "Some text",
      "",
      "<!-- start",
      "middle",
      "-->",
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[6, 7]])
  })

  test("closing tag inside HTML comment is ignored", () => {
    // The opening tag is visible but the closing tag is inside a comment
    const text = [
      "Preamble",
      "",
      "<tool-call with=\"x\">",
      "<!--",
      "</tool-call>",
      "-->",
      "",
      "</tool-call>",
      "",
    ].join("\n")
    const ranges = buildFoldingRanges(text)
    // Should find close at line 7, not the one inside the comment at line 4
    expect(toPairs(ranges)).toEqual([[2, 7]])
  })
})

// ── Blank line requirement ──────────────────────────────────────────

describe("blank line requirement", () => {
  test("foldable NOT preceded by blank line does not fold", () => {
    const text = [
      "Some text",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(buildFoldingRanges(text)).toEqual([])
  })

  test("foldable at start of input folds (implicit blank)", () => {
    const text = [
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[0, 1]])
  })

  test("foldable after blank line folds", () => {
    const text = [
      "Some text",
      "",
      "<tool-call with=\"x\">",
      "</tool-call>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([[2, 3]])
  })

  test("multiple foldables each preceded by blank lines", () => {
    const text = [
      "text",
      "",
      "<tool-call with=\"a\">",
      "</tool-call>",
      "",
      "<inline-attachment kind=\"hook\">",
      "<content>x</content>",
      "</inline-attachment>",
      "",
      "<thought-block provider=\"openai\">",
      "<summary>x</summary>",
      "</thought-block>",
      "",
    ].join("\n")
    expect(toPairs(buildFoldingRanges(text))).toEqual([
      [2, 3],
      [5, 7],
      [9, 11],
    ])
  })
})

// ── Collapsed text ──────────────────────────────────────────────────

describe("folding ranges (collapsedText)", () => {
  const originalNerdFont = process.env["NERD_FONT"]

  afterAll(() => {
    process.env["NERD_FONT"] = originalNerdFont
  })

  test("tool-call uses XML icon and name when NERD_FONT=1", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="my_db" kind="sqlite" icon="">\n<results>\n</results>\n</tool-call>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe(" my_db")
  })

  test("tool-call falls back to default icon when XML has no icon", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="remote" kind="a2a">\n<results>\n</results>\n</tool-call>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toEndWith(" remote")
  })

  test("tool-call shows text and name when NERD_FONT is not 1", () => {
    process.env["NERD_FONT"] = "0"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<tool-call with="my_db" kind="sqlite">\n<results>\n</results>\n</tool-call>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("[sqlite tool: my_db]")
  })

  test("inline-attachment shows attach icon when NERD_FONT=1", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="attach">\n<command>ls</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe(`${defaultInlineAttachmentIcon("attach")} attach`)
  })

  test("inline-attachment shows hook icon when NERD_FONT=1", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="hook">\n<command>hook.sh</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("󱐋 hook")
  })

  test("inline-attachment shows hook name when present", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="hook" name="audit" icon="🔎">\n<command>hook.sh</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("🔎 audit")

    process.env["NERD_FONT"] = "0"
    const rangesNoNerd = buildFoldingRanges(text)
    expect(rangesNoNerd[0].collapsedText).toBe("[hook: audit]")
  })

  test("inline-attachment prefers XML icon when NERD_FONT=1", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<inline-attachment kind="attach" icon="🧪">\n<command>hook.sh</command>\n<content>x</content>\n</inline-attachment>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toBe("🧪 attach")
  })

  test("thought-block collapsed text includes provider and kind", () => {
    process.env["NERD_FONT"] = "1"
    const text = `---\ninterlocutor:\n  name: Assistant\n---\n:::Assistant\n\n<thought-block provider="openai" provider-kind="reasoning">\n<summary>\n┆x\n</summary>\n</thought-block>\n:::\n`
    const ranges = buildFoldingRanges(text)
    expect(ranges[0].collapsedText).toEndWith(" openai reasoning")

    process.env["NERD_FONT"] = "0"
    const rangesNoNerd = buildFoldingRanges(text)
    expect(rangesNoNerd[0].collapsedText).toBe("[thought: openai reasoning]")
  })
})
