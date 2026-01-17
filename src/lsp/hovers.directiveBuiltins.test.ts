import { describe, test, expect } from "bun:test"
import { buildTestBundle } from "./utils/testHelpers"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

describe("hover: directive builtins", () => {
  test("shows docs for :env", async () => {
    const doc = [
      "---",
      "---",
      "Use :env[LECTIC_DATA] here.",
      "",
    ].join("\n")

    const bundle = buildTestBundle(doc)
    const off = doc.indexOf(":env") + 2
    const pos = offsetToPosition(doc, off)

    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()

    const md = (hover!.contents as any).value as string
    expect(md).toContain(":env")
    expect(md.toLowerCase()).toContain("environment")
  })

  test("shows docs for :fetch", async () => {
    const doc = [
      "---",
      "---",
      "See :fetch[<https://example.com>] here.",
      "",
    ].join("\n")

    const bundle = buildTestBundle(doc)
    const off = doc.indexOf(":fetch") + 2
    const pos = offsetToPosition(doc, off)

    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()

    const md = (hover!.contents as any).value as string
    expect(md).toContain(":fetch")
    expect(md.toLowerCase()).toContain("fetch")
  })
})
