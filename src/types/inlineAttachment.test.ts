import { describe, it, expect } from "bun:test"
import { serializeInlineAttachment, deserializeInlineAttachment } from "./inlineAttachment"

describe("inline attachment serialization", () => {
  it("roundtrips a simple cmd attachment", () => {
    const a = {
      kind: "cmd" as const,
      command: "echo hi",
      content: "<stdout from=\"echo hi\">hi\n</stdout>",
      mimetype: "text/plain",
    }
    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)
    expect(b.kind).toBe("cmd")
    expect(b.command).toBe(a.command)
    expect(b.content).toBe(a.content)
    expect(b.mimetype).toBe("text/plain")
  })

  it("roundtrips a simple attach attachment", () => {
    const a = {
      kind: "attach" as const,
      command: "",
      content: "derp",
      mimetype: "text/plain",
    }
    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)
    expect(b.kind).toBe("attach")
    expect(b.command).toBe("")
    expect(b.content).toBe("derp")
    expect(b.mimetype).toBe("text/plain")
  })

  it("roundtrips attachment with attributes", () => {
    const a: any = { 
        kind: "hook", 
        command: "test", 
        content: "foo", 
        mimetype: "text/plain",
        attributes: { abc: "text", other: 'val with "' }
    }
    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)
    expect(b.kind).toBe("hook")
    expect(b.attributes).toEqual({ abc: "text", other: 'val with "' })
  })
})
