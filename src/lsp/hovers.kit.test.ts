import { describe, test, expect } from "bun:test"
import { buildTestBundle } from "./utils/testHelpers"
import { computeHover } from "./hovers"
import { offsetToPosition } from "./positions"

describe("hover: kit", () => {
  test("includes kit description", async () => {
    const doc = [
      "---",
      "kits:",
      "  - name: typescript_tools",
      "    description: TS tooling",
      "    tools:",
      "      - exec: tsc --noEmit",
      "        name: tsc",
      "interlocutor:",
      "  name: A",
      "  prompt: hi",
      "  tools:",
      "    - kit: typescript_tools",
      "---",
      "",
    ].join("\n")

    const bundle = buildTestBundle(doc)
    const off = doc.indexOf("typescript_tools")
    const pos = offsetToPosition(doc, off)

    const hover = await computeHover(doc, pos, undefined, bundle)
    expect(hover).not.toBeNull()

    const md = (hover!.contents as any).value as string
    expect(md).toContain("kit")
    expect(md).toContain("typescript_tools")
    expect(md).toContain("TS tooling")
    expect(md).toContain("tsc")
  })
})
