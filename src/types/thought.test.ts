import { describe, it, expect } from "bun:test"
import {
  deserializeThoughtBlock,
  isSerializedThoughtBlock,
  serializeThoughtBlock,
  type ThoughtBlock,
} from "./thought"

describe("thought block serialization", () => {
  it("roundtrips a block with summary, content, and opaque", () => {
    const thought: ThoughtBlock = {
      provider: "openai",
      providerKind: "reasoning",
      id: "rs_123",
      status: "completed",
      order: 2,
      summary: [
        "Need to inspect parser behavior first.",
      ],
      content: [
        "Let me look at the parse output.",
      ],
      opaque: {
        encrypted_content: "AbCdEf==",
      },
    }

    const xml = serializeThoughtBlock(thought)
    const parsed = deserializeThoughtBlock(xml)

    expect(parsed).toEqual(thought)
    expect(isSerializedThoughtBlock(xml)).toBeTrue()
  })

  it("roundtrips multiple summary and content entries", () => {
    const thought: ThoughtBlock = {
      provider: "openai",
      providerKind: "reasoning",
      summary: ["first summary", "second summary"],
      content: ["first reasoning", "second reasoning"],
    }

    const xml = serializeThoughtBlock(thought)
    const parsed = deserializeThoughtBlock(xml)

    expect(parsed.summary).toEqual([
      "first summary",
      "second summary",
    ])
    expect(parsed.content).toEqual([
      "first reasoning",
      "second reasoning",
    ])
  })

  it("parses an Anthropic-style thinking block", () => {
    const xml = [
      '<thought-block provider="anthropic"',
      ' provider-kind="thinking" id="abc"',
      ' status="completed">',
      "<content>",
      "┆check streaming behavior",
      "</content>",
      '<opaque name="signature">sig123</opaque>',
      "</thought-block>",
    ].join("\n")

    const parsed = deserializeThoughtBlock(xml)

    expect(parsed.provider).toBe("anthropic")
    expect(parsed.providerKind).toBe("thinking")
    expect(parsed.id).toBe("abc")
    expect(parsed.content).toEqual([
      "check streaming behavior",
    ])
    expect(parsed.opaque).toEqual({ signature: "sig123" })
  })

  it("handles content with escaped tags", () => {
    const thought: ThoughtBlock = {
      content: [
        "<reasoning>line 1\nline 2</reasoning>",
      ],
    }

    const xml = serializeThoughtBlock(thought)
    const parsed = deserializeThoughtBlock(xml)

    expect(parsed.content).toEqual([
      "<reasoning>line 1\nline 2</reasoning>",
    ])
  })

  it("omits empty arrays in deserialized output", () => {
    const xml = [
      "<thought-block>",
      '<opaque name="data">xyz</opaque>',
      "</thought-block>",
    ].join("\n")

    const parsed = deserializeThoughtBlock(xml)
    expect(parsed.summary).toBeUndefined()
    expect(parsed.content).toBeUndefined()
    expect(parsed.opaque).toEqual({ data: "xyz" })
  })

  it("omits opaque when there are none", () => {
    const xml = [
      "<thought-block>",
      "<content>",
      "┆hello",
      "</content>",
      "</thought-block>",
    ].join("\n")

    const parsed = deserializeThoughtBlock(xml)
    expect(parsed.opaque).toBeUndefined()
    expect(parsed.content).toEqual(["hello"])
  })
})
