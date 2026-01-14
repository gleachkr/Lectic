import { describe, test, expect } from "bun:test"
import { buildTestBundle } from "./utils/testHelpers"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

describe("hover: macro directive", () => {
  test("includes macro description", async () => {
    const doc = [
      "---",
      "macros:",
      "  - name: summarize",
      "    description: Summarize the conversation.",
      "    expansion: exec:echo hi",
      "---",
      ":summarize[]",
      "",
    ].join("\n")

    const bundle = buildTestBundle(doc)
    const off = doc.lastIndexOf(":summarize") + 2
    const pos = offsetToPosition(doc, off)

    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()

    const md = (hover!.contents as any).value as string
    expect(md).toContain("macro")
    expect(md).toContain("summarize")
    expect(md).toContain("Summarize the conversation")
    expect(md).toContain("exec:echo hi")
  })

  test("does not escape inline backticks in macro description", async () => {
    const doc = [
      "---",
      "macros:",
      "  - name: summarize",
      "    description: Summarize using `bullet points`.",
      "    expansion: exec:echo hi",
      "---",
      ":summarize[]",
      "",
    ].join("\n")

    const bundle = buildTestBundle(doc)
    const off = doc.lastIndexOf(":summarize") + 2
    const pos = offsetToPosition(doc, off)

    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()

    const md = (hover!.contents as any).value as string
    expect(md).toContain("Summarize using `bullet points`.")
    expect(md).not.toContain("\u200b")
  })
})
