import { describe, it, expect } from "bun:test"
import { serializeInlineAttachment, deserializeInlineAttachment } from "./inlineAttachment"

describe("inline attachment serialization", () => {
  it("roundtrips a simple cmd attachment", () => {
    const a = { kind: "cmd" as const, command: "echo hi", content: "<stdout from=\"echo hi\">hi\n</stdout>", mimetype: "text/plain" }
    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)
    expect(b.kind).toBe("cmd")
    expect(b.command).toBe(a.command)
    expect(b.content).toBe(a.content)
    expect(b.mimetype).toBe("text/plain")
  })
})
