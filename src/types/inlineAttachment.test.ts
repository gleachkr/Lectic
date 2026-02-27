import { describe, it, expect } from "bun:test"
import {
  serializeInlineAttachment,
  deserializeInlineAttachment,
} from "./inlineAttachment"

describe("inline attachment serialization", () => {
  it("roundtrips an attachment", () => {
    const a = {
      kind: "attach" as const,
      command: "echo hi",
      content: "<stdout from=\"echo hi\">hi\n</stdout>",
      mimetype: "text/plain",
    }

    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)

    expect(xml).toContain('icon=""')
    expect(b.kind).toBe("attach")
    expect(b.command).toBe(a.command)
    expect(b.content).toBe(a.content)
    expect(b.mimetype).toBe("text/plain")
    expect(b.icon).toBe("")
  })

  it("roundtrips a simple attach attachment with empty command", () => {
    const a = {
      kind: "attach" as const,
      command: "",
      content: "derp",
      mimetype: "text/plain",
    }

    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)

    expect(xml).toContain('icon=""')
    expect(b.kind).toBe("attach")
    expect(b.command).toBe("")
    expect(b.content).toBe("derp")
    expect(b.mimetype).toBe("text/plain")
    expect(b.icon).toBe("")
  })

  it("roundtrips attachment with attributes", () => {
    const a: any = {
      kind: "hook",
      command: "test",
      content: "foo",
      mimetype: "text/plain",
      attributes: { abc: "text", other: 'val with "' },
    }

    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)

    expect(xml).toContain('icon="󱐋"')
    expect(b.kind).toBe("hook")
    expect(b.icon).toBe("󱐋")
    expect(b.attributes).toEqual({ abc: "text", other: 'val with "' })
  })

  it("uses a custom icon when provided", () => {
    const a = {
      kind: "attach" as const,
      command: "test",
      content: "foo",
      icon: "🧪",
    }

    const xml = serializeInlineAttachment(a)
    const b = deserializeInlineAttachment(xml)

    expect(xml).toContain('icon="🧪"')
    expect(b.icon).toBe("🧪")
  })
})
