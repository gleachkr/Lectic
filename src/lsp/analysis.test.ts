import { describe, expect, test } from "bun:test"
import { buildBundle } from "./analysis"

describe("analysis bundle", () => {
  test("collects assistant blocks and serialized child spans", () => {
    const text = [
      "---",
      "interlocutor:",
      "  name: Assistant",
      "  prompt: hi",
      "---",
      "Before",
      "",
      ":::Assistant",
      "<tool-call with=\"search\" kind=\"exec\">",
      "<arguments></arguments>",
      "<results></results>",
      "</tool-call>",
      "",
      "<inline-attachment kind=\"attach\">",
      "<command>cat</command>",
      "<content type=\"text/plain\">hi</content>",
      "</inline-attachment>",
      "",
      "<thought-block provider=\"openai\">",
      "<summary>x</summary>",
      "</thought-block>",
      ":::",
      "",
      "After",
      "",
    ].join("\n")

    const bundle = buildBundle(text)

    expect(bundle.blocks.map(b => b.kind)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(bundle.blocks[1]?.name).toBe("Assistant")

    expect(bundle.toolCallBlocks).toHaveLength(1)
    expect(bundle.inlineAttachmentBlocks).toHaveLength(1)
    expect(bundle.thoughtBlockBlocks).toHaveLength(1)

    const tool = bundle.toolCallBlocks[0]
    const attach = bundle.inlineAttachmentBlocks[0]
    const thought = bundle.thoughtBlockBlocks[0]

    expect(text.slice(tool.absStart, tool.absEnd)).toContain("<tool-call")
    expect(text.slice(attach.absStart, attach.absEnd)).toContain(
      "<inline-attachment"
    )
    expect(text.slice(thought.absStart, thought.absEnd)).toContain(
      "<thought-block"
    )
  })
})
